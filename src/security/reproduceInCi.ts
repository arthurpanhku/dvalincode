import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isTestPath } from '../remediation/evasion.js';
import { classifyReproExit, hashFiles, reproCommand, type ReproRunner } from '../remediation/reproduce.js';
import type { FixRecordReproduction } from './fixRecord.js';

const execFileAsync = promisify(execFile);

/**
 * Re-execute a record's reproduction where its issuer has no say.
 *
 * The local loop observed the tests fail on the vulnerable code and pass after
 * the fix. A record saying so is a claim. This makes it happen again on the CI
 * checkout: the change's code is temporarily reverted to the base commit — tests
 * kept — the tests are run and must fail, the change is restored, and the same
 * tests must pass.
 *
 * Reverting in place, rather than running in a base worktree, is deliberate. A
 * fresh worktree has no installed dependencies, so every test in it fails —
 * which would "confirm" any reproduction at all. The checkout CI already
 * prepared has them, and only the change's own files move.
 *
 * Only paths that look like tests are accepted from the record, and the
 * command comes from the base policy or inference, never from the record.
 */
export type CiReproduction = {
  status: 'confirmed' | 'not-confirmed' | 'not-attempted';
  detail: string[];
  command?: string;
  before?: { exitCode: number | null };
  after?: { exitCode: number | null };
  tests?: Array<{ path: string; sha256: string | null }>;
};

export async function rerunReproduction(input: {
  root: string;
  baseCommit: string;
  claimed: FixRecordReproduction;
  runner: ReproRunner | undefined;
  run: (command: string) => Promise<{ exitCode: number | null; tail: string }>;
}): Promise<CiReproduction> {
  if (!input.runner) {
    return { status: 'not-attempted', detail: ['no reproduction runner: set `reproduce` in the base commit\'s dvalin.security.json'] };
  }
  // The claim is untrusted input; its shape is checked before any of it is used.
  const claimedTests: unknown = input.claimed?.tests;
  if (!Array.isArray(claimedTests) || claimedTests.some(test => typeof test?.path !== 'string')) {
    return { status: 'not-confirmed', detail: ['the record\'s reproduction is malformed'] };
  }
  const paths = input.claimed.tests.map(test => test.path);
  const unsafe = paths.filter(file => path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !isTestPath(file));
  if (unsafe.length || !paths.length) {
    return { status: 'not-confirmed', detail: [`the record names reproduction paths that are not tests in this workspace: ${unsafe.join(', ') || 'none'}`] };
  }
  const tests = await hashFiles(input.root, paths);
  const drifted = tests.filter((test, index) => test.sha256 !== input.claimed.tests[index]!.sha256).map(test => test.path);
  if (drifted.length) {
    return { status: 'not-confirmed', detail: [`reproduction tests differ from the ones the record says failed before the fix: ${drifted.join(', ')}`], tests };
  }

  const command = reproCommand(input.runner.template, paths);
  const testSet = new Set(paths);
  const prefix = (await git(input.root, ['rev-parse', '--show-prefix'])).trim();
  const entries = (await git(input.root, ['diff', '--name-status', '--no-renames', '--relative', input.baseCommit, '--', '.']))
    .split('\n').filter(Boolean)
    .map(line => line.split('\t') as [string, string])
    .filter(([, file]) => file && !testSet.has(file));
  if (!entries.length) {
    return { status: 'not-confirmed', detail: ['the change has no code outside the reproduction tests, so there is no fix to revert'], command, tests };
  }

  // What to put back, captured before anything moves.
  const restore: Array<{ file: string; content: Buffer | null }> = [];
  for (const [code, file] of entries) {
    restore.push({ file, content: code.startsWith('D') ? null : await readFile(path.join(input.root, file)) });
  }

  let before: { exitCode: number | null; tail: string };
  try {
    for (const [code, file] of entries) {
      const target = path.join(input.root, file);
      if (code.startsWith('A')) {
        await rm(target, { force: true });
      } else {
        const original = await gitBuffer(input.root, ['show', `${input.baseCommit}:${prefix}${file}`]);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, original);
      }
    }
    before = await input.run(command);
  } finally {
    for (const { file, content } of restore) {
      const target = path.join(input.root, file);
      if (content === null) await rm(target, { force: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    }
  }
  const after = await input.run(command);

  const beforeOutcome = classifyReproExit(input.runner, before.exitCode, before.tail);
  const afterOutcome = classifyReproExit(input.runner, after.exitCode, after.tail);
  const detail: string[] = [];
  if (beforeOutcome !== 'failed') {
    detail.push(beforeOutcome === 'passed'
      ? 'the tests passed with the fix reverted, so they do not reproduce the finding'
      : `with the fix reverted the tests did not reach a failing assertion (exit ${before.exitCode ?? 'none'})`);
  }
  if (afterOutcome !== 'passed') detail.push(`with the fix in place the tests did not pass (exit ${after.exitCode ?? 'none'})`);
  return {
    status: detail.length ? 'not-confirmed' : 'confirmed',
    detail,
    command,
    before: { exitCode: before.exitCode },
    after: { exitCode: after.exitCode },
    tests,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
  return stdout;
}
