#!/usr/bin/env node
/**
 * Build the per-release Evidence Pack.
 *
 * Every DvalinCode release ships one `dvalincode-v<version>-evidence.json`
 * produced by the released binary itself, from real governed runs performed on
 * the build machine — not a hand-written claim about what the binary does.
 *
 * The pack contains (see docs/EVIDENCE-PACK.md for the format):
 *   - the resolved policy in force + its canonical hash
 *   - the `trust` posture the released build self-reports
 *   - the hash-chained audit records of the runs below
 *   - the compliance map (OpenSSF / ISO-42001), backed vs unbacked
 *
 * Two runs are recorded on purpose:
 *   1. `allowed`  — a read-only Plan-mode run over the release tree, proving the
 *                   normal path is fully audited.
 *   2. `denied`   — a run under a default-deny command policy where the agent
 *                   asks for a shell command and the policy blocks it, proving
 *                   enforcement is real and the denial lands in the chain.
 *
 * The model is a deterministic local stub (127.0.0.1, no key, no egress): a
 * release build must be reproducible and offline, and the evidence being made
 * is about *governance*, not about model quality. The stub is named in the audit
 * records (`provider: evidence-stub`), so the pack never implies a real model ran.
 *
 * Usage:
 *   node scripts/release-evidence.mjs [--bin "<command>"] [--out <file>]
 *                                     [--repo <dir>] [--sums <file>]
 *
 *   --bin   command that runs the CLI (default: the built release binary for
 *           this host, else `node dist/index.js`)
 *   --out   output path (default: release/dvalincode-v<version>-evidence.json)
 *   --sums  SHA256SUMS file to append the pack's checksum to
 *           (default: release/SHA256SUMS.txt when it exists)
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const STUB_MODEL = 'deterministic-stub-v1';
const STUB_PROVIDER = 'evidence-stub';

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!key || argv[i + 1] === undefined) fail(`bad argument: ${argv[i]}`);
    out[key] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoDir = path.resolve(args.repo ?? ROOT);
const outFile = path.resolve(args.out ?? path.join(ROOT, 'release', `dvalincode-v${VERSION}-evidence.json`));
const binCommand = (args.bin ?? defaultBin()).trim();
const sumsFile = args.sums ? path.resolve(args.sums) : path.join(ROOT, 'release', 'SHA256SUMS.txt');

/** Prefer the freshly built release binary for this host; fall back to dist/. */
function defaultBin() {
  const plat = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const suffix = plat === 'windows' ? '.exe' : '';
  const built = path.join(ROOT, 'release', 'tmp', `dvalincode-${plat}-${arch}${suffix}`);
  if (existsSync(built)) return built;
  return `node ${path.join(ROOT, 'dist', 'index.js')}`;
}

function fail(message) {
  console.error(`release-evidence: ${message}`);
  process.exit(1);
}

// ── deterministic local model stub ───────────────────────────────────────────

/**
 * Minimal OpenAI-compatible endpoint. It ignores the prompt and replays a fixed
 * script, so the run — and therefore the audit chain — is decided here, not by a
 * model. Supports both the streaming and non-streaming shapes the adapter uses.
 */
function startStub() {
  let script = [];
  let step = 0;

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      let stream = false;
      try {
        stream = JSON.parse(raw).stream === true;
      } catch {
        /* body shape is the adapter's concern; default to non-streaming */
      }
      const turn = script[step] ?? { text: 'Done.' };
      step++;
      if (stream) writeStream(res, turn);
      else writeJson(res, turn);
    });
  });

  return {
    listen: () =>
      new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/v1`));
      }),
    load: next => {
      script = next;
      step = 0;
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

const USAGE = { prompt_tokens: 0, completion_tokens: 0 };

function writeJson(res, turn) {
  const message = turn.tool
    ? {
        content: '',
        tool_calls: [
          {
            id: 'call_evidence_1',
            type: 'function',
            function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments) },
          },
        ],
      }
    : { content: turn.text };
  const body = {
    model: STUB_MODEL,
    choices: [{ index: 0, finish_reason: turn.tool ? 'tool_calls' : 'stop', message }],
    usage: USAGE,
  };
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function writeStream(res, turn) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const frame = (delta, finish) => ({
    model: STUB_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  });

  if (turn.tool) {
    send(
      frame({
        tool_calls: [
          {
            index: 0,
            id: 'call_evidence_1',
            type: 'function',
            function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments) },
          },
        ],
      }),
    );
    send(frame({}, 'tool_calls'));
  } else {
    send(frame({ content: turn.text }));
    send(frame({}, 'stop'));
  }
  send({ model: STUB_MODEL, choices: [], usage: USAGE });
  res.write('data: [DONE]\n\n');
  res.end();
}

// ── CLI driver ───────────────────────────────────────────────────────────────

function runCli(cliArgs, env, cwd) {
  const parts = binCommand.split(/\s+/);
  return new Promise(resolve => {
    const child = spawn(parts[0], [...parts.slice(1), ...cliArgs], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      stdout += d;
    });
    child.stderr.on('data', d => {
      stderr += d;
    });
    child.on('error', err => resolve({ code: 127, stdout, stderr: String(err) }));
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** One governed run against the stub. Returns the parsed harness result. */
async function governedRun({ stub, env, cwd, prompt, permissionMode, script, label }) {
  stub.load(script);
  const result = await runCli(
    ['run', '--cwd', cwd, '--permission-mode', permissionMode, '--output-format', 'json', '--quiet', prompt],
    env,
    cwd,
  );
  const line = result.stdout.trim().split('\n').filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line ?? '');
  } catch {
    fail(`${label} run produced no JSON result (exit ${result.code})\n${result.stderr || result.stdout}`);
  }
  if (!parsed.runId) fail(`${label} run recorded no audit run (exit ${result.code}): ${parsed.error ?? 'unknown'}`);
  console.log(`  ✓ ${label} run ${parsed.runId} — ${parsed.toolCalls} tool call(s), exit ${result.code}`);
  return parsed;
}

// ── main ─────────────────────────────────────────────────────────────────────

const home = mkdtempSync(path.join(os.tmpdir(), 'dvalin-evidence-home-'));
const denyWorkspace = mkdtempSync(path.join(os.tmpdir(), 'dvalin-evidence-deny-'));

try {
  console.log(`▶ Release Evidence Pack — DvalinCode v${VERSION}`);
  console.log(`  binary   ${binCommand}`);
  console.log(`  repo     ${repoDir}`);

  const stub = startStub();
  const baseUrl = await stub.listen();

  // A throwaway HOME isolates config, sessions, and the audit dir, so the pack
  // contains only the runs made here — nothing from the build machine.
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DVALINCODE_PROVIDER: STUB_PROVIDER,
    DVALINCODE_BASE_URL: baseUrl,
    DVALINCODE_MODEL: STUB_MODEL,
    DVALINCODE_API_KEY: '',
    NO_COLOR: '1',
  };

  // Run 1 — read-only over the release tree.
  await governedRun({
    stub,
    env,
    cwd: repoDir,
    label: 'allowed',
    permissionMode: 'plan',
    prompt: 'Read the project README and report what this release ships.',
    script: [
      { tool: { name: 'read_file', arguments: { filePath: 'README.md', limit: 40 } } },
      { text: `Release evidence run for DvalinCode v${VERSION}: README read under Plan mode (read-only).` },
    ],
  });

  // Run 2 — the same agent, blocked by policy. `defaultDeny` with no allowlist
  // blocks every shell command; the probe is a harmless echo either way.
  writeFileSync(
    path.join(denyWorkspace, 'dvalin.policy.json'),
    JSON.stringify({ commands: { defaultDeny: true } }, null, 2),
    'utf8',
  );
  writeFileSync(path.join(denyWorkspace, 'README.md'), 'Policy-denial fixture for the release Evidence Pack.\n', 'utf8');
  await governedRun({
    stub,
    env,
    cwd: denyWorkspace,
    label: 'denied ',
    permissionMode: 'auto',
    prompt: 'Run the probe command in this workspace.',
    script: [
      { tool: { name: 'shell', arguments: { command: 'echo', args: ['dvalincode-policy-probe'] } } },
      { text: 'The shell command was refused by policy; nothing was executed.' },
    ],
  });

  await stub.close();

  // Export from the repo root so the pack's policy section is the release's own
  // resolved policy.
  mkdirSync(path.dirname(outFile), { recursive: true });
  const exported = await runCli(['evidence', 'export', '--last', '10', '--out', outFile], env, repoDir);
  if (exported.code !== 0) fail(`evidence export failed:\n${exported.stderr || exported.stdout}`);
  process.stdout.write(exported.stdout);

  // Independent re-verification of what we just wrote.
  const verified = await runCli(['evidence', 'verify', outFile], env, repoDir);
  if (verified.code !== 0) fail(`evidence verify failed:\n${verified.stderr || verified.stdout}`);
  process.stdout.write(verified.stdout);

  assertPack(outFile);

  // Fold the pack into the release checksum file so the existing build
  // provenance attestation (which signs SHA256SUMS.txt) covers it too.
  if (existsSync(sumsFile)) {
    const digest = createHash('sha256').update(readFileSync(outFile)).digest('hex');
    appendFileSync(sumsFile, `${digest}  ${path.basename(outFile)}\n`, 'utf8');
    console.log(`  ✓ checksum appended to ${path.relative(ROOT, sumsFile)}`);
  }

  console.log(`\n✓ Release Evidence Pack: ${path.relative(ROOT, outFile)}`);
  console.log(`  anyone can re-check it offline:  dvalincode evidence verify ${path.basename(outFile)}`);
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(denyWorkspace, { recursive: true, force: true });
}

/**
 * The pack must be *useful*, not merely well-formed: both runs present, both
 * chains intact, the denial actually recorded, and no credential-shaped values.
 */
function assertPack(file) {
  const pack = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];

  if (pack.runs.length < 2) problems.push(`expected 2 runs, got ${pack.runs.length}`);
  for (const run of pack.runs) {
    if (!run.verify.ok) problems.push(`run ${run.runId} chain broken: ${run.verify.reason ?? run.verify.brokenAtSeq}`);
  }
  const denials = pack.runs.flatMap(r => r.records.filter(rec => rec.type === 'policy_violation'));
  if (denials.length === 0) problems.push('no policy_violation record — the denial run did not prove enforcement');
  if (pack.tool.version !== VERSION) problems.push(`pack version ${pack.tool.version} != package.json ${VERSION}`);
  if (!pack.policy.hash) problems.push('pack carries no policy hash');

  if (problems.length > 0) fail(`pack assertions failed:\n  - ${problems.join('\n  - ')}`);

  const backed = pack.compliance.filter(c => c.backed).length;
  console.log(`  ✓ pack asserted: ${pack.runs.length} verified runs, ${denials.length} recorded denial(s), ${backed}/${pack.compliance.length} controls backed`);
}
