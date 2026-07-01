import { governedMcpFetch, type McpEgressContext } from './governedFetch.js';

/**
 * A minimal, hand-rolled MCP client over the Streamable HTTP transport — no SDK,
 * to preserve DvalinCode's zero-runtime-deps posture. It speaks only the three
 * JSON-RPC methods v1 needs (`initialize`, `tools/list`, `tools/call`) and reads
 * responses whether the server replies with `application/json` or a
 * `text/event-stream` (SSE) body. All network I/O goes through `governedMcpFetch`.
 */

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'dvalincode', version: '0.9.0' };

export type McpToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export type McpContent = { type: string; text?: string; [key: string]: unknown };
export type McpCallResult = { content?: McpContent[]; isError?: boolean };

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

export type McpServerRef = { id: string; url: string };

export class McpClient {
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(
    private readonly server: McpServerRef,
    private readonly authHeaders: Record<string, string>,
  ) {}

  /**
   * Handshake: `initialize` then the `notifications/initialized` acknowledgement.
   * The egress context is passed per call so tool invocations can be audited
   * against the live per-run sink (which the discovery step does not yet have).
   */
  async initialize(egress: McpEgressContext): Promise<void> {
    await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, 'initialize', egress);
    await this.notify('notifications/initialized', egress);
  }

  async listTools(egress: McpEgressContext): Promise<McpToolDef[]> {
    const msg = await this.request('tools/list', {}, 'tools/list', egress);
    return (msg.result?.tools as McpToolDef[] | undefined) ?? [];
  }

  async callTool(name: string, args: unknown, egress: McpEgressContext): Promise<McpCallResult> {
    const msg = await this.request('tools/call', { name, arguments: args ?? {} }, name, egress);
    return (msg.result as McpCallResult | undefined) ?? {};
  }

  // ── transport ────────────────────────────────────────────────────────────

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...this.authHeaders,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  /** Send a JSON-RPC request and return the response message; throws on JSON-RPC error. */
  private async request(method: string, params: Record<string, unknown>, auditTool: string, egress: McpEgressContext): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const res = await governedMcpFetch(
      this.server.url,
      { method: 'POST', headers: this.baseHeaders(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) },
      egress,
      auditTool,
    );
    // The server assigns a session on initialize; carry it on every later call.
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    if (!res.ok) throw new Error(`MCP ${method} failed: HTTP ${res.status}`);
    const msg = await readJsonRpc(res, id);
    if (msg.error) throw new Error(`MCP ${method} error: ${msg.error.message ?? `code ${msg.error.code}`}`);
    return msg;
  }

  /** Fire-and-forget notification (no id, no response expected). */
  private async notify(method: string, egress: McpEgressContext): Promise<void> {
    try {
      const res = await governedMcpFetch(
        this.server.url,
        { method: 'POST', headers: this.baseHeaders(), body: JSON.stringify({ jsonrpc: '2.0', method }) },
        egress,
        method,
      );
      await res.body?.cancel().catch(() => undefined);
    } catch {
      // Notifications are best-effort; a failure here must not abort discovery.
    }
  }
}

/**
 * Read a JSON-RPC response whether the body is `application/json` (single object)
 * or a `text/event-stream` (SSE) carrying the response as a `data:` event. For a
 * short request/response this reads the full body — v1 does not stream partials.
 */
async function readJsonRpc(res: Response, id: number | string): Promise<JsonRpcMessage> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    return (await res.json()) as JsonRpcMessage;
  }
  const text = await res.text();
  let fallback: JsonRpcMessage | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(payload) as JsonRpcMessage;
    } catch {
      continue;
    }
    if (msg.result === undefined && msg.error === undefined) continue;
    if (msg.id === id) return msg;
    fallback ??= msg;
  }
  if (fallback) return fallback;
  throw new Error('no JSON-RPC response found in SSE stream');
}
