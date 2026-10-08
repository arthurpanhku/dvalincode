import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reproduce, then fix.
 *
 * "The scanner stopped reporting it" is a weak oracle: rules have blind spots,
 * and a loop that optimizes against them learns where they are. A test is a
 * stronger one, but only if the test is not written by the same hand to fit the
 * fix. So the order is fixed and observed:
 *
 * 1. Before any fix, the executor writes a test that exercises the finding.
 *    Dvalin runs it on the still-vulnerable code and requires it to **fail**.
 * 2. The test files are hashed. The fix must make them **pass without being
 *    touched** — a changed reproduction test is an open problem, not a pass.
 *
 * What the flip proves is exactly this: a test written before the fix failed on
 * the vulnerable code and passes after it, unchanged. It does not prove the test
 * exercises the vulnerability rather than something adjacent — the prompt asks
 * for that and a reviewer can read it, but nothing here can check it.
 */

export type ReproRunner = {
  /** A command with `{files}` (space-separated test paths) or `{dirs}` (their `./dir` packages). */
  template: string;
  source: 'flag' | 'config' | 'inferred';
  /**
   * Exit codes that mean the runner itself failed — not found, usage error, no
   * tests collected — rather than that a test failed. A reproduction "fails"
   * only when a test does; a broken runner is not evidence of a vulnerability.
   */
  errorExitCodes: number[];
};

export type ReproOutcome = 'failed' | 'passed' | 'error';

const ALWAYS_ERROR = [126, 127];

/**
 * How to run just the reproduction tests.
 *
 * An explicit flag wins, then the policy file's `reproduce`, then inference
 * from the project. The executor never chooses: a runner it picked could be one
 * that fails on anything and passes on anything.
 */
export async function resolveReproRunner(cwd: string, options: { flag?: string; configured?: string } = {}): Promise<ReproRunner | undefined> {
  if (options.flag) return { template: options.flag, source: 'flag', errorExitCodes: ALWAYS_ERROR };
  if (options.configured) return { template: options.configured, source: 'config', errorExitCodes: ALWAYS_ERROR };

  const pkg = await readJson(path.join(cwd, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) } as Record<string, unknown>;
    const testScript = String((pkg.scripts as Record<string, unknown> | undefined)?.test ?? '');
    if ('vitest' in deps || /\bvitest\b/.test(testScript)) return { template: 'npx --no-install vitest run {files}', source: 'inferred', errorExitCodes: ALWAYS_ERROR };
    if ('jest' in deps || /\bjest\b/.test(testScript)) return { template: 'npx --no-install jest {files}', source: 'inferred', errorExitCodes: ALWAYS_ERROR };
    if ('mocha' in deps || /\bmocha\b/.test(testScript)) return { template: 'npx --no-install mocha {files}', source: 'inferred', errorExitCodes: ALWAYS_ERROR };
    if (/\bnode\s+--test\b/.test(testScript)) return { template: 'node --test {files}', source: 'inferred', errorExitCodes: ALWAYS_ERROR };
  }
  for (const file of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'requirements.txt', 'requirements-dev.txt']) {
    const content = await readFile(path.join(cwd, file), 'utf8').catch(() => '');
    // pytest: 2 interrupted, 3 internal error, 4 usage error, 5 no tests collected.
    if (/\bpytest\b/.test(content)) return { template: 'python -m pytest {files}', source: 'inferred', errorExitCodes: [...ALWAYS_ERROR, 2, 3, 4, 5] };
  }
  if (await readFile(path.join(cwd, 'go.mod'), 'utf8').then(() => true, () => false)) {
    return { template: 'go test {dirs}', source: 'inferred', errorExitCodes: ALWAYS_ERROR };
  }
  return undefined;
}

export function reproCommand(template: string, files: string[]): string {
  const quote = (value: string) => (/\s/.test(value) ? `"${value}"` : value);
  const dirs = [...new Set(files.map(file => `./${path.posix.dirname(file.split(path.sep).join('/'))}`.replace(/\/\.$/, '')))];
  return template
    .replace('{files}', files.map(quote).join(' '))
    .replace('{dirs}', dirs.map(quote).join(' '));
}

/**
 * Output that means the run never reached a test. Includes a test importing a
 * module that does not exist yet: a test that fails only because the fix has
 * not been written is a test of the fix's name, not of the vulnerability.
 */
const RUNNER_ERROR = /command not found|is not recognized as an internal|could not determine executable|npx canceled|missing script|no test files found|no tests? (?:ran|found)|collected 0 items|cannot find module|err_module_not_found|modulenotfounderror/i;

export function classifyReproExit(runner: Pick<ReproRunner, 'errorExitCodes'>, exitCode: number | null, output = ''): ReproOutcome {
  if (exitCode === 0) return 'passed';
  if (exitCode === null || runner.errorExitCodes.includes(exitCode) || RUNNER_ERROR.test(output)) return 'error';
  return 'failed';
}

export async function hashFiles(cwd: string, files: string[]): Promise<Array<{ path: string; sha256: string | null }>> {
  return Promise.all(files.map(async file => {
    const content = await readFile(path.join(cwd, file)).catch(() => null);
    return { path: file, sha256: content ? createHash('sha256').update(content).digest('hex') : null };
  }));
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
