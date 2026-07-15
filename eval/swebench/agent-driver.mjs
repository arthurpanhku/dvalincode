#!/usr/bin/env node
// Headless one-turn driver for SWE-bench runs. Uses the same governed entry
// point as the web GUI and TUI (runAgentTurn): org policy, audit chain, and
// approval chokepoints all apply. Mode: Code + Bypass Permissions.
// Requires a fresh `npm run build` (imports from dist/).
// Usage: node agent-driver.mjs <workspace-repo> <prompt-file> <out-json>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const { runAgentTurn } = await import(new URL('../../dist/agent/session.js', import.meta.url));

const [cwd, promptFile, outFile] = process.argv.slice(2);
if (!cwd || !promptFile || !outFile) {
  console.error('usage: node agent-driver.mjs <workspace-repo> <prompt-file> <out-json>');
  process.exit(2);
}

const content = readFileSync(promptFile, 'utf8');
const timeoutMin = Number(process.env.AGENT_TIMEOUT_MIN ?? 25);
const maxIterations = Number(process.env.AGENT_MAX_ITERATIONS ?? 25);
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const trunc = (s, n = 160) => (s.length > n ? s.slice(0, n) + '…' : s);

let toolCalls = 0;
const onEvent = (e) => {
  if (e.type === 'tool_call') {
    toolCalls++;
    console.error(`[${elapsed()}] tool#${toolCalls} ${e.name} ${trunc(JSON.stringify(e.input ?? {}))}`);
  } else if (e.type === 'tool_error') {
    console.error(`[${elapsed()}] tool-error ${e.name}: ${trunc(e.error)}`);
  } else if (e.type === 'llm_iteration') {
    console.error(`[${elapsed()}] iteration ${e.iteration}`);
  }
};

try {
  const res = await runAgentTurn(
    {
      content,
      cwd: path.resolve(cwd),
      mode: 'code',
      codePermissionMode: 'bypass',
      turnConfig: { maxIterations },
      signal: AbortSignal.timeout(timeoutMin * 60_000),
    },
    {
      onEvent,
      onProviderSelected: (p, m) => console.error(`provider: ${p} · model: ${m}`),
    },
  );
  const out = {
    ok: true,
    sessionId: res.sessionId,
    providerId: res.providerId,
    model: res.model,
    runId: res.result.runId,
    auditHead: res.result.auditHead,
    iterationsUsed: res.result.iterationsUsed,
    usage: res.result.usage,
    toolCalls,
    wallSeconds: (Date.now() - t0) / 1000,
    maxIterations,
    output: res.result.output,
    reportMarkdown: res.reportMarkdown,
  };
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.error(
    `done in ${elapsed()}: iterations=${out.iterationsUsed} toolCalls=${toolCalls} runId=${out.runId ?? 'n/a'}`,
  );
  process.exit(0);
} catch (err) {
  writeFileSync(
    outFile,
    JSON.stringify(
      { ok: false, error: String(err?.message ?? err), toolCalls, wallSeconds: (Date.now() - t0) / 1000 },
      null,
      2,
    ),
  );
  console.error(`FAILED after ${elapsed()}: ${err?.stack ?? err}`);
  process.exit(1);
}
