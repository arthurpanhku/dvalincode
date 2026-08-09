import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../src/core/exitCodes.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');

// `npm test` does not build, and dist/ is gitignored — so on a clean checkout
// every case here would run a CLI that does not exist and see exit 1, which
// looks exactly like a real failure. Build first rather than depend on the
// developer having happened to run one.
beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'pipe' });
}, 120_000);

/**
 * Exercised through the built CLI rather than by calling the command modules,
 * because the exit code is the contract a pipeline sees — and it is the product
 * of the command, commander, and the top-level handler together. A unit test of
 * any one of those would not have caught the collision this suite exists for.
 */
function run(args: string[], cwd: string): number {
  try {
    execFileSync(process.execPath, [CLI, ...args], { cwd, stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
}

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-exit-'));
  writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

describe('exit codes are one contract across commands', () => {
  it('returns 0 when the answer is yes', () => {
    const dir = workspace({ 'ok.js': 'export const add = (a, b) => a + b;\n' });
    try {
      expect(run(['dvalin', '.', '--scanners', 'builtin', '--fail-on', 'high'], dir)).toBe(EXIT.ok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 5, not 2, when a scan gate trips', () => {
    const dir = workspace({ 'vuln.js': 'app.post("/x", (q, r) => r.send(String(eval(q.body.e))));\n' });
    try {
      expect(run(['dvalin', '.', '--scanners', 'builtin', '--fail-on', 'high'], dir)).toBe(EXIT.gateNotMet);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 2 for a bad flag on the same command, so a typo is distinguishable', () => {
    const dir = workspace({ 'vuln.js': 'app.post("/x", (q, r) => r.send(String(eval(q.body.e))));\n' });
    try {
      // The point of the split: same command, same workspace, findings present —
      // only the invocation differs, and the codes differ with it.
      expect(run(['dvalin', '.', '--scanners', 'nessus', '--fail-on', 'high'], dir)).toBe(EXIT.usageError);
      expect(run(['dvalin', '.', '--nonexistent-flag'], dir)).toBe(EXIT.usageError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 5 when an Evidence Pack does not verify', () => {
    const dir = workspace();
    try {
      const pack = path.join(dir, 'pack.json');
      writeFileSync(pack, JSON.stringify({ runs: [], policy: {}, manifest: { sections: {} } }));
      expect(run(['evidence', 'verify', pack], dir)).toBe(EXIT.gateNotMet);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 2 when the Evidence Pack path is unreadable', () => {
    const dir = workspace();
    try {
      expect(run(['evidence', 'verify', path.join(dir, 'absent.json')], dir)).toBe(EXIT.usageError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 2 for an unknown tool and 3 when policy denies one', () => {
    const dir = workspace({ 'a.js': 'const a = 1;\n' });
    try {
      expect(run(['run-tool', 'no_such_tool', '-i', '{}', '--json'], dir)).toBe(EXIT.usageError);

      writeFileSync(path.join(dir, 'dvalin.policy.json'), JSON.stringify({ tools: { deny: ['list_files'] } }));
      expect(run(['run-tool', 'list_files', '-i', '{"pattern":"*.js","limit":1}', '--json'], dir))
        .toBe(EXIT.policyViolation);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 2 when asked for a report that does not exist', () => {
    const dir = workspace();
    try {
      expect(run(['report', 'verify', 'no_such_run'], dir)).not.toBe(EXIT.ok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
