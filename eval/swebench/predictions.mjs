#!/usr/bin/env node
// Collect a batch's per-instance agent patches into a SWE-bench predictions
// file for the official Docker harness (Phase 2). One JSON object per line:
//   {"instance_id", "model_name_or_path", "model_patch"}
// model_patch is the agent's staged diff (agent.diff) — the same repo-relative
// git diff the official harness applies at /testbed in each per-instance image.
//
// Usage: node predictions.mjs <batch-dir> [out.jsonl]
// Env:   MODEL_NAME=dvalincode   (model_name_or_path recorded in predictions)
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const batch = process.argv[2];
if (!batch) {
  console.error('usage: node predictions.mjs <batch-dir> [out.jsonl]');
  process.exit(2);
}
const out = process.argv[3] || path.join(batch, 'predictions.jsonl');
const modelName = process.env.MODEL_NAME || 'dvalincode';

const lines = [];
let empty = 0;
let missing = 0;
const agentModels = new Set();
for (const ent of readdirSync(batch, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const dir = path.join(batch, ent.name);
  const diffPath = path.join(dir, 'agent.diff');
  if (!existsSync(diffPath)) { missing++; continue; } // agent never ran (env-skipped)
  const patch = readFileSync(diffPath, 'utf8');
  if (!patch.trim()) { empty++; continue; }            // agent produced no change

  // instance_id from result.json (authoritative), else the directory name.
  let instanceId = ent.name;
  const rj = path.join(dir, 'result.json');
  if (existsSync(rj)) {
    try {
      const r = JSON.parse(readFileSync(rj, 'utf8'));
      if (r.instance_id) instanceId = r.instance_id;
      if (r.agent?.model) agentModels.add(r.agent.model);
    } catch { /* keep the directory-name fallback */ }
  }
  lines.push(JSON.stringify({
    instance_id: instanceId,
    model_name_or_path: modelName,
    model_patch: patch,
  }));
}

if (!lines.length) {
  console.error(`no non-empty agent.diff found under ${batch}`);
  process.exit(1);
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} prediction(s) → ${out}`);
console.log(`  model_name_or_path: ${modelName}${agentModels.size ? `  (agent model(s): ${[...agentModels].join(', ')})` : ''}`);
if (empty)   console.log(`  skipped ${empty} instance(s) with an empty patch (agent produced no change)`);
if (missing) console.log(`  skipped ${missing} dir(s) with no agent.diff (agent never ran — env-skipped)`);
