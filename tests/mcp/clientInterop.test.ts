import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Interoperability, not unit behaviour.
 *
 * `server.test.ts` calls the server in-process with request strings this
 * repository writes itself, which cannot catch a misreading of the protocol —
 * both sides would be wrong in the same way. This drives the built binary as a
 * child process over a real pipe, using the reference client implementation,
 * which is what an actual harness does.
 *
 * That is the class of bug this exists for: negotiating the protocol version by
 * echoing the client's own value back was a real regression here, and it would
 * have looked correct to any test that built its own requests.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../../dist/index.js');

/**
 * The build is a precondition, not an optional extra. Locally it is friendlier
 * to say so than to fail cryptically; in CI a missing build must be loud, or
 * this stops running the day someone reorders a job and nobody notices.
 */
const BUILT = existsSync(CLI);
if (!BUILT && process.env.DVALIN_REQUIRE_MCP_INTEROP === '1') {
  throw new Error(`MCP interop tests require a build: ${CLI} is missing. Run \`npm run build\` first.`);
}

const suite = BUILT ? describe : describe.skip;

suite('an independent MCP client can drive the published server', () => {
  let workspace: string;
  let client: Client;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'dvalin-mcp-interop-'));
    await writeFile(
      path.join(workspace, 'app.js'),
      ['export function run(req) {', '  return eval(req.body.expression);', '}', ''].join('\n'), // scanner fixture
      'utf8',
    );

    client = new Client({ name: 'dvalin-interop-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'mcp-serve', '--workspace', workspace],
        cwd: workspace,
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it('completes the handshake and reports who it is', () => {
    const server = client.getServerVersion();

    expect(server?.name).toBeTruthy();
    expect(server?.version).toBeTruthy();
  });

  it('advertises the tools an agent is told to call', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name).sort();

    // The set documented in integrations/claude-code/README.md. A tool that
    // silently disappears breaks instructions people have already committed.
    expect(names).toEqual([
      'dvalin_begin_verification',
      'dvalin_get_evidence',
      'dvalin_get_finding',
      'dvalin_get_session',
      'dvalin_list_scanners',
      'dvalin_run_task',
      'dvalin_scan',
      'dvalin_verify_findings',
      'dvalin_verify_fix',
    ]);
  });

  it('gives every tool a description and a valid input schema', async () => {
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.inputSchema?.type, `${tool.name} has no object input schema`).toBe('object');
    }
  });

  it('runs a real scan through a tool call and returns findings a client can read', async () => {
    const result = await client.callTool({
      name: 'dvalin_scan',
      arguments: { scanners: ['builtin'] },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find(part => part.type === 'text')?.text ?? '';
    const body = JSON.parse(text) as {
      totalFindings: number;
      findings: Array<{ ruleId: string; path: string }>;
    };

    expect(body.totalFindings).toBeGreaterThan(0);
    expect(body.findings.map(finding => finding.ruleId)).toContain('dvalin/eval');
    expect(body.findings[0]!.path).toBe('app.js');
  }, 60_000);

  it('reports an unknown tool as a tool error, not a protocol error', async () => {
    // MCP puts a failed call in the result rather than the JSON-RPC envelope,
    // so a client sees a usable message instead of a broken transport.
    const result = await client.callTool({ name: 'dvalin_not_a_tool', arguments: {} });

    expect(result.isError).toBe(true);

    // And the session survives it: one bad call must not end the connection.
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  }, 60_000);

  it('rejects a workspace outside the launch allowlist', async () => {
    const result = await client.callTool({
      name: 'dvalin_scan',
      arguments: { cwd: '/', scanners: ['builtin'] },
    });

    expect(result.isError).toBe(true);
  }, 60_000);
});
