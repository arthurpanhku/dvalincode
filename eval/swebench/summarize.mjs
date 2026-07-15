#!/usr/bin/env node
// Aggregate a batch directory of per-instance result.json files into a
// SUMMARY.md: resolved rate, failure classification by stage, per-repo
// breakdown, and cost/latency/token totals. The failure classification is the
// point — it's the handle for data-driven agent improvement.
//
// Usage: node summarize.mjs results/batches/<ts>
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const batch = process.argv[2];
if (!batch) {
  console.error('usage: node summarize.mjs <batch-dir>');
  process.exit(2);
}

const results = [];
for (const name of readdirSync(batch, { withFileTypes: true })) {
  if (!name.isDirectory()) continue;
  const f = path.join(batch, name.name, 'result.json');
  if (existsSync(f)) {
    try {
      results.push(JSON.parse(readFileSync(f, 'utf8')));
    } catch {
      results.push({ instance_id: name.name, resolved: false, stage: 'unparseable_result' });
    }
  }
}

if (!results.length) {
  console.error(`no result.json files under ${batch}`);
  process.exit(1);
}

const repoOf = (id) => id.split('__')[0] || 'unknown';
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);

const total = results.length;
const resolved = results.filter((r) => r.resolved);
const nResolved = resolved.length;

// Failure classification. Resolved → `resolved`. Instances that completed the
// pipeline (`done`) but didn't resolve are split by *why*: the target test
// still fails (fix didn't work) vs the fix works but breaks held-out tests
// (regression). Everything else is bucketed by the stage where it stopped.
const bucketOf = (r) => {
  if (r.resolved) return 'resolved';
  if (r.stage === 'done') {
    // F2P is the primary signal. If it errored (env/collection) we can't judge
    // the agent → eval_error. A clean F2P *fail* is a definitive agent miss,
    // regardless of P2P. Only when F2P passes does P2P decide regression.
    if (r.f2p_outcome === 'error') return 'eval_error';
    if (r.f2p_outcome === 'fail' || num(r.f2p_exit) !== 0) return 'unresolved_fix_failed';
    if (r.p2p_outcome === 'error') return 'eval_error';
    if (r.p2p_outcome === 'fail' || num(r.p2p_exit) !== 0) return 'p2p_regression';
    return 'unresolved_other';
  }
  return r.stage || 'unknown';
};
const byStage = {};
for (const r of results) {
  const key = bucketOf(r);
  byStage[key] = (byStage[key] || 0) + 1;
}

// Per-repo resolved rate.
const repos = {};
for (const r of results) {
  const repo = repoOf(r.instance_id);
  repos[repo] ??= { total: 0, resolved: 0 };
  repos[repo].total++;
  if (r.resolved) repos[repo].resolved++;
}

// Cost / latency / tokens over instances that actually ran the agent.
let inTok = 0;
let outTok = 0;
let cachedTok = 0;
let cacheMissTok = 0;
let cacheWriteTok = 0;
let wall = 0;
let iterations = 0;
let toolCalls = 0;
let withAgent = 0;
const models = new Set();
for (const r of results) {
  const a = r.agent;
  if (!a) continue;
  withAgent++;
  inTok += num(a.usage?.inputTokens);
  outTok += num(a.usage?.outputTokens);
  cachedTok += num(a.usage?.cachedInputTokens);
  cacheMissTok += num(a.usage?.cacheMissInputTokens);
  cacheWriteTok += num(a.usage?.cacheWriteInputTokens);
  wall += num(a.wallSeconds);
  iterations += num(a.iterationsUsed);
  toolCalls += num(a.toolCalls);
  if (a.model) models.add(a.model);
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '0.0');
const stageRows = Object.entries(byStage)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `| \`${k}\` | ${v} | ${pct(v, total)}% |`)
  .join('\n');
const repoRows = Object.entries(repos)
  .sort((a, b) => b[1].total - a[1].total)
  .map(([k, v]) => `| ${k} | ${v.resolved}/${v.total} | ${pct(v.resolved, v.total)}% |`)
  .join('\n');

const md = `# Batch summary — \`${path.basename(batch)}\`

Generated ${new Date().toISOString()} · harness: local-venv smoke (non-official).

## Headline

- **Resolved: ${nResolved}/${total} (${pct(nResolved, total)}%)**
- Model(s): ${[...models].map((m) => `\`${m}\``).join(', ') || 'n/a'}
- Agent ran on ${withAgent}/${total} instances (rest failed before the agent).

## Outcome / failure classification

| Bucket | Count | Share |
|---|---|---|
${stageRows}

Buckets: \`resolved\` (F2P+P2P pass) · \`unresolved_fix_failed\` (target test still fails) · \`p2p_regression\` (fix works but breaks held-out tests) · \`eval_error\` (test errored at eval — env/collection, not an agent miss) · \`env\` (venv/pip build) · \`env_broken_at_test\` (test never ran at base — dep/collection error) · \`precheck*\` (bad instance/env drift) · \`resolve_unsupported\` (test-id mapping) · \`agent\` (agent crash) · \`instance_timeout\` · \`harness_error\`.

## Per-repo resolved rate

| Repo | Resolved | Rate |
|---|---|---|
${repoRows}

## Cost & latency (agent instances only)

| Metric | Total | Mean/instance |
|---|---|---|
| Input tokens | ${inTok.toLocaleString()} | ${withAgent ? Math.round(inTok / withAgent).toLocaleString() : 0} |
| Output tokens | ${outTok.toLocaleString()} | ${withAgent ? Math.round(outTok / withAgent).toLocaleString() : 0} |
| Cached input tokens | ${cachedTok.toLocaleString()} | ${withAgent ? Math.round(cachedTok / withAgent).toLocaleString() : 0} |
| Cache-miss input tokens | ${cacheMissTok.toLocaleString()} | ${withAgent ? Math.round(cacheMissTok / withAgent).toLocaleString() : 0} |
| Cache-write input tokens | ${cacheWriteTok.toLocaleString()} | ${withAgent ? Math.round(cacheWriteTok / withAgent).toLocaleString() : 0} |
| Prompt-cache hit rate | ${cachedTok + cacheMissTok ? `${pct(cachedTok, cachedTok + cacheMissTok)}%` : 'n/a'} | — |
| Wall-clock (s) | ${wall.toFixed(0)} | ${withAgent ? (wall / withAgent).toFixed(1) : 0} |
| Iterations | ${iterations} | ${withAgent ? (iterations / withAgent).toFixed(1) : 0} |
| Tool calls | ${toolCalls} | ${withAgent ? (toolCalls / withAgent).toFixed(1) : 0} |

_Tokens are provider-billed; on a caching provider input tokens are largely cache reads. Not official-harness comparable — see README caveats._
`;

const out = path.join(batch, 'SUMMARY.md');
writeFileSync(out, md);
console.log(md);
console.log(`\nwrote ${out}`);
