#!/usr/bin/env node
// Fetch the ENTIRE SWE-bench Lite test split from the Hugging Face
// datasets-server API, cache every instance as instances/<id>.json (so
// run-one.sh's fetch step becomes a cache hit), and write a manifest
// instances/_lite.json that classifies each instance as runnable or not under
// this local-venv harness.
//
// Runnability mirrors run-one.sh's resolve_ids():
//   - django/django            → not runnable (Django test runner, not pytest)
//   - any bare test name AND    → not runnable (can't map name → path::name)
//     test_patch touches != 1 file
//   - otherwise                 → runnable
//
// Usage: node fetch-dataset.mjs [--refresh]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'instances');
const manifestFile = path.join(outDir, '_lite.json');
const refresh = process.argv.includes('--refresh');

const DATASET = 'princeton-nlp/SWE-bench_Lite';
const base =
  'https://datasets-server.huggingface.co/rows?dataset=' +
  encodeURIComponent(DATASET) +
  '&config=default&split=test';

function testFilesOf(testPatch) {
  // Files touched by test_patch, from `diff --git a/<f> b/<f>` headers.
  const files = [];
  for (const line of String(testPatch || '').split('\n')) {
    const m = /^diff --git a\/(\S+) b\/\S+/.exec(line);
    if (m) files.push(m[1]);
  }
  return files;
}

function parseIds(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function classify(row) {
  if (row.repo === 'django/django') {
    return { runnable: false, reason: 'django-test-runner' };
  }
  const ids = [...parseIds(row.FAIL_TO_PASS), ...parseIds(row.PASS_TO_PASS)];
  const hasBare = ids.some((t) => !t.includes('::'));
  const nTestFiles = testFilesOf(row.test_patch).length;
  if (hasBare && nTestFiles !== 1) {
    return { runnable: false, reason: `bare-names-with-${nTestFiles}-test-files` };
  }
  return { runnable: true, reason: 'pytest-resolvable' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (i === attempts) throw err;
      await sleep(1000 * 2 ** (i - 1));
      continue;
    }
    if (res.ok) return res.json();
    // 503/429/5xx from the datasets-server are transient — back off and retry.
    if ((res.status >= 500 || res.status === 429) && i < attempts) {
      process.stderr.write(`\r  ${res.status} — retry ${i}/${attempts - 1} after backoff…`);
      await sleep(1000 * 2 ** (i - 1));
      continue;
    }
    throw new Error(`HF datasets-server ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error('unreachable');
}

async function fetchViaDatasetsServer() {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const data = await fetchPage(`${base}&offset=${offset}&length=100`);
    if (!data.rows?.length) break;
    for (const r of data.rows) rows.push(r.row);
    process.stderr.write(`\rfetched ${rows.length} rows…                         `);
    if (data.rows.length < 100) break;
  }
  process.stderr.write('\n');
  return rows;
}

// Fallback: the datasets-server is frequently down. Pull the parquet straight
// from the hub CDN and decode it via pyarrow in a cached tool venv.
function fetchViaParquet() {
  const python = process.env.PYTHON || 'python3.11';
  const venv = path.join(here, '.venv-tools');
  const venvPy = path.join(venv, 'bin', 'python');
  if (!existsSync(venvPy)) {
    console.error('provisioning tool venv (pyarrow) for parquet fallback…');
    run(python, ['-m', 'venv', venv]);
    run(venvPy, ['-m', 'pip', '-q', 'install', '-U', 'pip']);
    run(venvPy, ['-m', 'pip', '-q', 'install', 'pyarrow']);
  }
  const res = spawnSync(venvPy, [path.join(here, 'parquet-to-jsonl.py')], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (res.status !== 0) throw new Error(`parquet fallback failed (exit ${res.status})`);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${res.status}`);
}

async function fetchAll() {
  try {
    return await fetchViaDatasetsServer();
  } catch (err) {
    console.error(`datasets-server unavailable (${err.message.split('\n')[0]}); trying parquet CDN…`);
    return fetchViaParquet();
  }
}

mkdirSync(outDir, { recursive: true });

let rows;
if (!refresh && existsSync(manifestFile)) {
  const cached = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (cached.instances?.every((i) => existsSync(path.join(outDir, `${i.instance_id}.json`)))) {
    console.log(`cached: ${manifestFile} (${cached.instances.length} instances; --refresh to re-pull)`);
    process.exit(0);
  }
}

rows = await fetchAll();
if (!rows.length) {
  console.error('no rows returned from datasets-server');
  process.exit(1);
}

const instances = [];
for (const row of rows) {
  writeFileSync(path.join(outDir, `${row.instance_id}.json`), JSON.stringify(row, null, 2));
  const cls = classify(row);
  instances.push({
    instance_id: row.instance_id,
    repo: row.repo,
    version: row.version,
    runnable: cls.runnable,
    reason: cls.reason,
    n_test_files: testFilesOf(row.test_patch).length,
  });
}

const runnable = instances.filter((i) => i.runnable);
const byRepo = {};
for (const i of runnable) byRepo[i.repo] = (byRepo[i.repo] || 0) + 1;

const manifest = {
  dataset: DATASET,
  fetched_at: new Date().toISOString(),
  total: instances.length,
  runnable: runnable.length,
  runnable_by_repo: byRepo,
  instances,
};
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

console.log(`saved manifest: ${manifestFile}`);
console.log(`total ${instances.length} · runnable ${runnable.length} · excluded ${instances.length - runnable.length}`);
console.log('runnable by repo:', JSON.stringify(byRepo));
const excluded = {};
for (const i of instances.filter((x) => !x.runnable)) excluded[i.reason] = (excluded[i.reason] || 0) + 1;
console.log('excluded by reason:', JSON.stringify(excluded));
