#!/usr/bin/env node
// Phase 2 — fold the OFFICIAL SWE-bench Docker verdict together with the
// on-host governance/cost metrics we recorded per instance, into
// SUMMARY.official.md. This is the governance-tax read: an official-comparable
// resolved rate next to the tokens / iterations / wall-clock the agent spent
// under full governance (seatbelt sandbox + audit chain).
//
// Usage: node summarize-official.mjs <batch-dir> <official-report.json>
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const batch = process.argv[2];
const reportPath = process.argv[3];
if (!batch || !reportPath) {
  console.error('usage: node summarize-official.mjs <batch-dir> <official-report.json>');
  process.exit(2);
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

// Official report id-lists (defensive: the schema has varied across versions).
const ids = (k) => (Array.isArray(report[k]) ? report[k] : []);
const resolvedIds = new Set(ids('resolved_ids'));
const unresolvedIds = new Set(ids('unresolved_ids'));
const errorIds = new Set(ids('error_ids'));
const emptyIds = new Set(ids('empty_patch_ids'));
const verdictOf = (id) =>
  resolvedIds.has(id) ? 'resolved'
  : errorIds.has(id) ? 'error'
  : emptyIds.has(id) ? 'empty_patch'
  : unresolvedIds.has(id) ? 'unresolved'
  : 'not_submitted';

// Our on-host records (governance/cost) per instance.
const local = {};
for (const ent of readdirSync(batch, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const f = path.join(batch, ent.name, 'result.json');
  if (!existsSync(f)) continue;
  try {
    const r = JSON.parse(readFileSync(f, 'utf8'));
    local[r.instance_id || ent.name] = r;
  } catch { /* skip unparseable */ }
}

const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '0.0');
// Only a completed local F2P/P2P evaluation is comparable. In --no-precheck
// mode `resolved:false` is a placeholder while the result awaits Docker.
const hasLocalVerdict = (result) => result?.stage === 'done' && typeof result.resolved === 'boolean';

const submitted = report.submitted_instances ??
  (resolvedIds.size + unresolvedIds.size + errorIds.size + emptyIds.size);
const nResolved = report.resolved_instances ?? resolvedIds.size;

// One row per instance we ran or the report mentions, sorted by id.
const allIds = [...new Set([
  ...Object.keys(local), ...resolvedIds, ...unresolvedIds, ...errorIds, ...emptyIds,
])].sort();
const rows = allIds.map((id) => {
  const a = local[id]?.agent;
  const official = verdictOf(id);
  const localVerdict = id in local
    ? (local[id].resolved ? 'resolved' : (local[id].stage || 'unresolved'))
    : '—';
  const drift = hasLocalVerdict(local[id]) && (official === 'resolved') !== local[id].resolved ? ' ⚠️' : '';
  return `| ${id} | **${official}**${drift} | ${localVerdict} | ${a?.iterationsUsed ?? '—'} | ${a ? num(a.usage?.inputTokens).toLocaleString() : '—'} | ${a?.wallSeconds != null ? a.wallSeconds.toFixed(0) : '—'} | ${a?.auditHead ? a.auditHead.slice(0, 12) : '—'} |`;
});

// Cost aggregates over instances that actually ran the agent.
let inTok = 0, outTok = 0, cachedTok = 0, cacheMissTok = 0, cacheWriteTok = 0, wall = 0, withAgent = 0;
const models = new Set();
for (const r of Object.values(local)) {
  const a = r.agent;
  if (!a) continue;
  withAgent++;
  inTok += num(a.usage?.inputTokens);
  outTok += num(a.usage?.outputTokens);
  cachedTok += num(a.usage?.cachedInputTokens);
  cacheMissTok += num(a.usage?.cacheMissInputTokens);
  cacheWriteTok += num(a.usage?.cacheWriteInputTokens);
  wall += num(a.wallSeconds);
  if (a.model) models.add(a.model);
}

// Local-vs-official drift: instances the local venv graded differently.
let drift = 0;
let locallyCompared = 0;
for (const id of allIds) {
  if (!hasLocalVerdict(local[id])) continue;
  locallyCompared++;
  if ((verdictOf(id) === 'resolved') !== local[id].resolved) drift++;
}

const perResolvedInt = (t) => (nResolved ? Math.round(t / nResolved).toLocaleString() : '—');

const md = `# Official (Docker) summary — \`${path.basename(batch)}\`

Generated ${new Date().toISOString()} · harness: **official SWE-bench Docker** (per-instance images) · report: \`${path.basename(reportPath)}\`.

## Headline

- **Resolved (official): ${nResolved}/${submitted} (${pct(nResolved, submitted)}%)**
- Agent model(s): ${[...models].map((m) => `\`${m}\``).join(', ') || 'n/a'} — ran on-host under seatbelt + audit chain.
- Official buckets: resolved ${resolvedIds.size} · unresolved ${unresolvedIds.size} · error ${errorIds.size} · empty_patch ${emptyIds.size}.
- **Local-vs-official drift: ${locallyCompared ? `${drift}/${locallyCompared}` : 'n/a'}**${locallyCompared ? ' completed local verdict(s) differed' : ' — no comparable local verdicts (`--no-precheck`)'}.

## Per-instance — official verdict × on-host governance cost

| Instance | Official | Local | Iters | Input tok | Wall s | Audit head |
|---|---|---|---|---|---|---|
${rows.join('\n')}

⚠️ = a completed local F2P/P2P evaluation and official Docker disagree on resolution; \`awaiting_official\` is unknown and is not counted as drift.

## Governance-tax read (agent instances only)

| Metric | Total | Mean/instance | Per resolved |
|---|---|---|---|
| Input tokens | ${inTok.toLocaleString()} | ${withAgent ? Math.round(inTok / withAgent).toLocaleString() : 0} | ${perResolvedInt(inTok)} |
| Output tokens | ${outTok.toLocaleString()} | ${withAgent ? Math.round(outTok / withAgent).toLocaleString() : 0} | ${perResolvedInt(outTok)} |
| Cached input tokens | ${cachedTok.toLocaleString()} | ${withAgent ? Math.round(cachedTok / withAgent).toLocaleString() : 0} | ${perResolvedInt(cachedTok)} |
| Cache-miss input tokens | ${cacheMissTok.toLocaleString()} | ${withAgent ? Math.round(cacheMissTok / withAgent).toLocaleString() : 0} | ${perResolvedInt(cacheMissTok)} |
| Cache-write input tokens | ${cacheWriteTok.toLocaleString()} | ${withAgent ? Math.round(cacheWriteTok / withAgent).toLocaleString() : 0} | ${perResolvedInt(cacheWriteTok)} |
| Prompt-cache hit rate | ${cachedTok + cacheMissTok ? `${pct(cachedTok, cachedTok + cacheMissTok)}%` : 'n/a'} | — | — |
| Wall-clock (s) | ${wall.toFixed(0)} | ${withAgent ? (wall / withAgent).toFixed(1) : 0} | ${nResolved ? (wall / nResolved).toFixed(1) : '—'} |

_Official verdict is Docker-based and comparable to published SWE-bench Lite numbers. Cost/governance metrics are from the on-host agent run (provider-billed tokens; seatbelt-sandboxed; audit chain head recorded per instance)._
`;

const outPath = path.join(batch, 'SUMMARY.official.md');
writeFileSync(outPath, md);
console.log(md);
console.log(`\nwrote ${outPath}`);
