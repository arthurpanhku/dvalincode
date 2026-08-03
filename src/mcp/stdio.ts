import path from 'node:path';
import { checkCommand, PolicyViolationError } from '../core/policy.js';
import { spawnGovernedSession, type GovernedSession } from '../core/subprocessSandbox.js';
import { CLIENT_INFO, PROTOCOL_VERSION, type McpCallResult, type McpToolDef } from './client.js';
import type { McpEgressContext } from './governedFetch.js';

/**
 * The stdio MCP transport: the server runs as a local child process and JSON-RPC
 * messages are exchanged as newline-delimited JSON over its stdin/stdout. No
 * network is involved, which is the point — a local server stays reachable under
 * `network: off`, where a remote gateway is correctly blocked.
 *
 * Two governance surfaces exist here that the remote transport does not have:
 *
 * 1. **Command admission.** Launching a server is command execution, and it
 *    happens at registration time rather than inside `registry.run`. The
 *    registry's `checkCommand` chokepoint therefore does not cover it, so this
 *    module applies `checkCommand` itself. Without it, `mcp.servers` would be a
 *    side door around the shell-command denylist.
 * 2. **Process isolation.** The child is launched through
 *    `spawnGovernedSession`, so a policy that forbids egress puts the server
 *    behind the same Seatbelt/Bubblewrap isolation as any shell command, and
 *    fails closed where that isolation is unavailable.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

export type LocalMcpServerRef = { id: string; command: string; args: string[] };

export class McpStdioClient {
  private session: GovernedSession | undefined;
  private nextId = 1;
  private buffer = '';
  private exitReason: string | undefined;
  private readonly pending = new Map<number, { resolve: (msg: JsonRpcMessage) => void; reject: (err: Error) => void }>();

  constructor(
    private readonly server: LocalMcpServerRef,
    private readonly cwd: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /** Executable name only — arguments never reach the audit trail. */
  private get host(): string {
    return `stdio:${path.basename(this.server.command)}`;
  }

  async initialize(ctx: McpEgressContext): Promise<void> {
    this.start(ctx);
    await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, 'initialize', ctx);
    this.notify('notifications/initialized');
  }

  async listTools(ctx: McpEgressContext): Promise<McpToolDef[]> {
    const msg = await this.request('tools/list', {}, 'tools/list', ctx);
    return (msg.result?.tools as McpToolDef[] | undefined) ?? [];
  }

  async callTool(name: string, args: unknown, ctx: McpEgressContext): Promise<McpCallResult> {
    const msg = await this.request('tools/call', { name, arguments: args ?? {} }, name, ctx);
    return (msg.result as McpCallResult | undefined) ?? {};
  }

  /** Stop the server. Safe to call when it was never started. */
  close(): void {
    this.session?.kill();
    this.failPending(new Error('MCP server session closed'));
  }

  // ── transport ────────────────────────────────────────────────────────────

  private start(ctx: McpEgressContext): void {
    if (this.session) return;

    // The one check the tool-layer chokepoint cannot make for us: this launch
    // happens before any tool call exists to gate.
    const commandLine = [this.server.command, ...this.server.args].join(' ');
    const decision = checkCommand(ctx.policy, commandLine);
    if (!decision.allowed) {
      ctx.audit?.append({ type: 'mcp_request', server: this.server.id, tool: 'initialize', host: this.host, outcome: 'blocked', durationMs: 0 });
      ctx.audit?.append({ type: 'policy_violation', rule: decision.rule, tool: `mcp:${this.server.id}`, target: this.host });
      throw new PolicyViolationError(`mcp:${this.server.id}`, decision.rule, this.host);
    }

    this.session = spawnGovernedSession({
      command: this.server.command,
      args: this.server.args,
      cwd: this.cwd,
      policy: ctx.policy,
      audit: ctx.audit,
      toolName: `mcp:${this.server.id}`,
      // Follow the policy rather than always isolating: a permissive policy lets
      // a server reach the network like any other governed command, while
      // network: off keeps it sealed.
      skipNetworkSandboxWhenPolicyAllows: true,
    });

    this.session.child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')));
    this.session.child.on('error', err => {
      this.exitReason = err.message;
      this.failPending(new Error(`MCP server "${this.server.id}" failed to start: ${err.message}`));
    });
    this.session.child.on('close', code => {
      this.exitReason ??= `exited with code ${code}`;
      this.failPending(new Error(`MCP server "${this.server.id}" ${this.exitReason}`));
    });
  }

  /** Split the stdout stream on newlines; each complete line is one JSON-RPC message. */
  private consume(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // Not a JSON-RPC frame (servers sometimes print banners); ignore.
    }
    if (typeof msg.id !== 'number') return; // Notification or unmatched response.
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    waiter.resolve(msg);
  }

  private failPending(err: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    auditTool: string,
    ctx: McpEgressContext,
  ): Promise<JsonRpcMessage> {
    const started = Date.now();
    try {
      const msg = await this.send(method, params);
      if (msg.error) throw new Error(`MCP ${method} error: ${msg.error.message ?? `code ${msg.error.code}`}`);
      ctx.audit?.append({ type: 'mcp_request', server: this.server.id, tool: auditTool, host: this.host, outcome: 'ok', durationMs: Date.now() - started });
      return msg;
    } catch (err) {
      ctx.audit?.append({ type: 'mcp_request', server: this.server.id, tool: auditTool, host: this.host, outcome: 'error', durationMs: Date.now() - started });
      throw err;
    }
  }

  private send(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const stdin = this.session?.child.stdin;
    if (!stdin) return Promise.reject(new Error(`MCP server "${this.server.id}" has no stdin`));

    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: msg => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });

      // A JSON-RPC frame must occupy exactly one line.
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, err => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Fire-and-forget notification: no id, no response expected. */
  private notify(method: string): void {
    try {
      this.session?.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    } catch {
      // Best-effort; a failure here must not abort discovery.
    }
  }
}
