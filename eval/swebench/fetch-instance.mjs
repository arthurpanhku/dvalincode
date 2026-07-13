#!/usr/bin/env node
// Fetch one SWE-bench Lite instance from the Hugging Face datasets-server API
// and cache it as instances/<instance_id>.json. No Python or HF deps needed.
// Usage: node fetch-instance.mjs sympy__sympy-24152
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
if (!id) {
  console.error('usage: node fetch-instance.mjs <instance_id>');
  process.exit(2);
}

const outDir = path.join(here, 'instances');
const outFile = path.join(outDir, `${id}.json`);
if (existsSync(outFile)) {
  console.log(`cached: ${outFile}`);
  process.exit(0);
}

const DATASET = 'princeton-nlp/SWE-bench_Lite';
const base =
  'https://datasets-server.huggingface.co/rows?dataset=' +
  encodeURIComponent(DATASET) +
  '&config=default&split=test';

let row;
for (let offset = 0; offset < 400 && !row; offset += 100) {
  const res = await fetch(`${base}&offset=${offset}&length=100`);
  if (!res.ok) {
    console.error(`HF datasets-server ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  if (!data.rows?.length) break;
  row = data.rows.map((r) => r.row).find((r) => r.instance_id === id);
}

if (!row) {
  console.error(`instance not found in ${DATASET}: ${id}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(row, null, 2));
console.log(`saved: ${outFile}`);
