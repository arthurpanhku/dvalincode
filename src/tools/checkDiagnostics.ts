import path from 'node:path';

export type CheckDiagnostic = { file: string; line: number; column?: number; message: string };

/** Parse the common machine-readable location lines without inferring test success. */
export function parseCheckDiagnostics(output: string, cwd: string): CheckDiagnostic[] {
  const diagnostics: CheckDiagnostic[] = [];
  const seen = new Set<string>();
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  let failure: string | undefined;
  let lintFile: string | undefined;
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    const failureLine = /^(?:FAIL(?:ED)?\s+|not ok\s+\d+\s*-\s*|(?:AssertionError|TypeError|ReferenceError|Error):\s*)(.+)$/.exec(trimmed);
    if (failureLine) failure = failureLine[1].slice(0, 500);
    if (/^(?:[A-Za-z]:)?[/\\].+\.[\w-]+$/.test(trimmed)) lintFile = trimmed;
    if (!trimmed) lintFile = undefined;
    const lint = lintFile ? /^(\d+):(\d+)\s+(?:error|warning)\s+(.+)$/.exec(trimmed) : null;
    const tsc = /^(.+?)\((\d+),(\d+)\):\s*(?:error|warning)\s+(.+)$/.exec(trimmed);
    const location = /^((?:[A-Za-z]:)?[^:()]+?\.[\w-]+):(\d+)(?::(\d+))?:\s*(?:E\s+)?(\S.*)$/.exec(trimmed);
    const frame = /^(?:❯|at)\s+(?:.*?\s+\()?((?:[A-Za-z]:)?[^:()]+?\.[\w-]+):(\d+):(\d+)\)?$/.exec(trimmed);
    const match = tsc ?? location ?? frame ?? (lint ? [lint[0], lintFile!, lint[1], lint[2], lint[3]] : null);
    if (!match) continue;

    const file = path.relative(cwd, path.resolve(cwd, match[1]));
    if (!file || file === '..' || file.startsWith(`..${path.sep}`) || path.isAbsolute(file)) continue;
    const lineNumber = Number(match[2]);
    const column = match[3] ? Number(match[3]) : undefined;
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) continue;
    const diagnostic = {
      file: file.split(path.sep).join('/'),
      line: lineNumber,
      ...(column === undefined ? {} : { column }),
      message: frame ? (failure ?? 'Failure reported at this location') : match[4].slice(0, 500),
    };
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(diagnostic);
    if (diagnostics.length >= 50) break;
  }
  return diagnostics;
}
