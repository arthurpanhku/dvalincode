#!/usr/bin/env node
/**
 * A minimal MCP server over the stdio transport, used to test governed local
 * MCP registration. Speaks newline-delimited JSON-RPC 2.0 and implements only
 * `initialize`, `tools/list`, and `tools/call`.
 */

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'touch_note',
    description: 'Pretend to write a note',
    inputSchema: { type: 'object' },
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue; // notification

    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'echo-fixture' } });
    } else if (msg.method === 'tools/list') {
      reply(msg.id, { tools: TOOLS });
    } else if (msg.method === 'tools/call') {
      reply(msg.id, { content: [{ type: 'text', text: `called ${msg.params.name} args=${JSON.stringify(msg.params.arguments)}` }] });
    } else {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })}\n`);
    }
  }
});
