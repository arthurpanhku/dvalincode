import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SecurityFindingSnapshot } from '../security/contracts.js';
import type { FixRecordEvasion } from '../security/fixRecord.js';

const execFileAsync = promisify(execFile);

/**
 * Ways to make a finding stop being reported without fixing it.
 *
 * The suppression guard handles the bluntest one — telling the scanner to
 * look away. These are the next ones an agent under "until the scanner is
 * clean" pressure reaches for, and each is visible in the diff:
 *
 * - **equivalent sink**: the dangerous call is rewritten into a sibling the
 *   rule does not match — `eval(x)` becomes `new Function(x)()`, `exec(cmd)`
 *   becomes `spawn(cmd, { shell: true })`. The vulnerability is the same; only
 *   the spelling moved. Flagged when the change adds a sink of the same family
 *   as a target it claims to fix.
 * - **target file deleted**: the finding is gone because the code is. Removing
 *   functionality may be right, but it is a product decision, not a repair, and
 *   it is made by a person in its own change.
 * - **tests deleted or assertions removed**: the checks pass because they ask
 *   less. A fix that needs a test to stop asserting is not a fix.
 *
 * These are heuristics, and say so: a signal is a reason the loop will not
 * call the change verified, with the evidence attached, not a claim of intent.
 * What is not detected here — a sink in a family not listed, logic deleted
 * inside a file that survives, untested changed lines — is not detected.
 */
export type EvasionSignal =
  | { kind: 'equivalent-sink'; path: string; line: number; family: SinkFamily; text: string }
  | { kind: 'target-file-deleted'; path: string; ruleId: string }
  | { kind: 'test-deleted'; path: string }
  | { kind: 'assertions-removed'; path: string; removed: number };

export type SinkFamily = 'code-execution' | 'command-execution' | 'sql' | 'html' | 'deserialization';

/** Which family a finding belongs to, read from its rule and message. */
const FAMILY_OF_FINDING: Array<{ family: SinkFamily; pattern: RegExp }> = [
  { family: 'code-execution', pattern: /\beval\b|code[-_ ]?injection|dynamic code|function constructor/i },
  { family: 'command-execution', pattern: /command[-_ ]?injection|os[-_ ]?command|shell|child[-_ ]?process|subprocess/i },
  { family: 'sql', pattern: /\bsql\b|sqli/i },
  { family: 'html', pattern: /xss|cross[-_ ]?site|html[-_ ]?injection|innerhtml|dangerously/i },
  { family: 'deserialization', pattern: /deserializ|pickle|unserialize|yaml\.load/i },
];

/** Dangerous calls per family. A fix for that family that adds one of these has moved the sink, not removed it. */
const SINKS: Record<SinkFamily, RegExp[]> = {
  'code-execution': [
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\b(?:setTimeout|setInterval)\s*\(\s*['"`]/,
    /\bvm\.(?:runIn\w*|compileFunction)\s*\(/,
    /\bexec\s*\(\s*compile\s*\(/,
  ],
  'command-execution': [
    /\bshell\s*:\s*true\b/,
    /\bshell\s*=\s*True\b/,
    /\bexecSync\s*\(/,
    /\bchild_process\.exec\s*\(/,
    /\bos\.(?:system|popen)\s*\(/,
    /\bRuntime\.getRuntime\(\)\.exec\s*\(/,
  ],
  sql: [
    /['"`]\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^'"`]*['"`]\s*\+/i,
    /\$\{[^}]+\}[^`]*\b(?:FROM|WHERE|VALUES|SET)\b|\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/i,
    /\.(?:raw|unsafe|queryRaw|executeRaw)\w*\s*\(/,
    /\bf['"]\s*(?:SELECT|INSERT|UPDATE|DELETE)\b/i,
  ],
  html: [
    /\b(?:innerHTML|outerHTML)\s*=/,
    /\bdangerouslySetInnerHTML\b/,
    /\binsertAdjacentHTML\s*\(/,
    /\bdocument\.write(?:ln)?\s*\(/,
    /\bv-html\b/,
    /\|\s*safe\b|\bmark_safe\s*\(/,
  ],
  deserialization: [
    /\bpickle\.loads?\s*\(/,
    /\byaml\.load\s*\((?![^)]*SafeLoader)/,
    /\bunserialize\s*\(/,
    /\bObjectInputStream\b/,
    /\bMarshal\.load\b/,
  ],
};

const TEST_PATH = /(?:^|\/)(?:tests?|specs?|__tests__|testdata)\/|(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|(?:^|\/)[^/]*_test\.(?:py|go)$|(?:^|\/)[^/]*Tests?\.(?:java|kt|cs)$/i;
const ASSERTION = /\b(?:expect|assert\w*|should|t\.(?:Error|Fatal)\w*|require\.\w+|verify)\b/;

export function isTestPath(file: string): boolean {
  return TEST_PATH.test(file.split('\\').join('/'));
}

export function sinkFamilyOf(finding: Pick<SecurityFindingSnapshot, 'ruleId' | 'message'>): SinkFamily | undefined {
  const text = `${finding.ruleId} ${finding.message}`;
  return FAMILY_OF_FINDING.find(entry => entry.pattern.test(text))?.family;
}

export async function detectEvasion(
  cwd: string,
  baseCommit: string,
  targets: SecurityFindingSnapshot[],
  options: { exempt?: string[] } = {},
): Promise<EvasionSignal[]> {
  const exempt = new Set(options.exempt ?? []);
  const signals: EvasionSignal[] = [];

  const status = await git(cwd, ['diff', '--name-status', '--no-renames', '--relative', baseCommit, '--', '.']);
  const deleted = new Set<string>();
  for (const line of status.split('\n').filter(Boolean)) {
    const [code, file] = line.split('\t');
    if (code?.startsWith('D') && file) deleted.add(file);
  }
  for (const target of targets) {
    if (deleted.has(target.path)) signals.push({ kind: 'target-file-deleted', path: target.path, ruleId: target.ruleId });
  }
  for (const file of deleted) {
    if (isTestPath(file) && !exempt.has(file)) signals.push({ kind: 'test-deleted', path: file });
  }

  const diff = parseDiff(await git(cwd, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--relative', baseCommit, '--', '.']));
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);

  const families = new Set(targets.map(sinkFamilyOf).filter((family): family is SinkFamily => Boolean(family)));
  const addedLines = new Map(diff.added);
  for (const file of untracked) {
    if (addedLines.has(file)) continue;
    const content = await readTracked(cwd, file);
    addedLines.set(file, content.split('\n').map((text, index) => ({ line: index + 1, text })));
  }
  for (const [file, lines] of addedLines) {
    // A test that exercises the vulnerable call is how reproduction works.
    if (isTestPath(file) || exempt.has(file)) continue;
    for (const { line, text } of lines) {
      for (const family of families) {
        if (SINKS[family].some(pattern => pattern.test(text))) {
          signals.push({ kind: 'equivalent-sink', path: file, line, family, text: text.trim().slice(0, 160) });
          break;
        }
      }
    }
  }

  for (const [file, removed] of diff.removed) {
    if (!isTestPath(file) || exempt.has(file) || deleted.has(file)) continue;
    const lostAssertions = removed.filter(text => ASSERTION.test(text)).length
      - (diff.added.get(file) ?? []).filter(({ text }) => ASSERTION.test(text)).length;
    if (lostAssertions > 0) signals.push({ kind: 'assertions-removed', path: file, removed: lostAssertions });
  }
  return signals;
}

/** The record's form of a signal: location and kind, no code (FV-15). */
export function toRecordEvasion(signal: EvasionSignal): FixRecordEvasion {
  switch (signal.kind) {
    case 'equivalent-sink': return { kind: signal.kind, path: signal.path, line: signal.line, family: signal.family };
    case 'target-file-deleted': return { kind: signal.kind, path: signal.path, ruleId: signal.ruleId };
    case 'test-deleted': return { kind: signal.kind, path: signal.path };
    case 'assertions-removed': return { kind: signal.kind, path: signal.path, removed: signal.removed };
  }
}

export function describeEvasion(signal: EvasionSignal): string {
  switch (signal.kind) {
    case 'equivalent-sink':
      return `${signal.path}:${signal.line} adds a ${signal.family} sink (\`${signal.text}\`) — the same kind of call the fix was meant to remove`;
    case 'target-file-deleted':
      return `${signal.path} was deleted; ${signal.ruleId} is gone because the code is, which is a product decision for a person, not a repair`;
    case 'test-deleted':
      return `${signal.path} (a test) was deleted`;
    case 'assertions-removed':
      return `${signal.path} lost ${signal.removed} assertion(s)`;
  }
}

export function evasionKey(signal: EvasionSignal): string {
  return signal.kind === 'equivalent-sink'
    ? `evasion:${signal.kind}:${signal.path}:${signal.text}`
    : `evasion:${signal.kind}:${signal.path}`;
}

/** Added and removed lines per file from a zero-context diff, new-side line numbers for additions. */
export function parseDiff(diff: string): {
  added: Map<string, Array<{ line: number; text: string }>>;
  removed: Map<string, string[]>;
} {
  const added = new Map<string, Array<{ line: number; text: string }>>();
  const removed = new Map<string, string[]>();
  let oldFile: string | undefined;
  let newFile: string | undefined;
  let next = 0;
  let inHeader = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHeader = true;
      oldFile = newFile = undefined;
      continue;
    }
    if (inHeader) {
      if (raw.startsWith('--- ')) {
        const name = raw.slice(4).trim();
        oldFile = name === '/dev/null' ? undefined : name.replace(/^a\//, '');
        continue;
      }
      if (raw.startsWith('+++ ')) {
        const name = raw.slice(4).trim();
        newFile = name === '/dev/null' ? undefined : name.replace(/^b\//, '');
        continue;
      }
      if (!raw.startsWith('@@')) continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHeader = false;
      next = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+') && newFile) {
      added.set(newFile, [...(added.get(newFile) ?? []), { line: next, text: raw.slice(1) }]);
      next += 1;
    } else if (raw.startsWith('-') && oldFile) {
      removed.set(oldFile, [...(removed.get(oldFile) ?? []), raw.slice(1)]);
    }
  }
  return { added, removed };
}

async function readTracked(cwd: string, file: string): Promise<string> {
  return readFile(path.join(cwd, file), 'utf8').catch(() => '');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
