import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { loadIgnorePatterns } from '../core/ignorefile.js';
import { buildRemediationPrompt, type RemediationFinding, type SarifImportResult } from './sarif.js';

const DEFAULT_IGNORES = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/dist-bin/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.cache/**',
  '**/.vite/**',
  '**/*.min.js',
  '**/*-lock.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
];

const SCANNABLE_EXTENSIONS = new Set([
  '.cjs',
  '.cs',
  '.env',
  '.go',
  '.java',
  '.js',
  '.jsx',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

const MAX_FILES = 3000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FINDINGS = 100;
const CONTEXT_RADIUS = 3;

type LocalRule = {
  id: string;
  name: string;
  severity: RemediationFinding['severity'];
  securitySeverity: string;
  tags: string[];
  helpUri: string;
  pattern: RegExp;
  message: (match: RegExpMatchArray) => string;
};

const RULES: LocalRule[] = [
  {
    id: 'dvalin/hardcoded-secret',
    name: 'Hardcoded secret-like value',
    severity: 'error',
    securitySeverity: '8.0',
    tags: ['security', 'secret', 'cwe-798'],
    helpUri: 'https://cwe.mitre.org/data/definitions/798.html',
    pattern: /\b(api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*['"]([^'"\s]{12,})['"]/i,
    message: (match) => `Possible hardcoded ${match[1]} value. Move secrets to approved runtime configuration or a secret manager.`,
  },
  {
    id: 'dvalin/aws-access-key',
    name: 'AWS access key literal',
    severity: 'error',
    securitySeverity: '9.0',
    tags: ['security', 'secret', 'aws', 'cwe-798'],
    helpUri: 'https://cwe.mitre.org/data/definitions/798.html',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    message: () => 'Possible AWS access key literal. Revoke the key if real and replace it with secret-managed credentials.',
  },
  {
    id: 'dvalin/sql-string-concatenation',
    name: 'SQL built with string concatenation',
    severity: 'error',
    securitySeverity: '8.8',
    tags: ['security', 'sql-injection', 'cwe-089'],
    helpUri: 'https://cwe.mitre.org/data/definitions/89.html',
    pattern: /\b(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*['"`]\s*\+|\+\s*[^;\n]*['"`][^'"`\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b/i,
    message: () => 'SQL appears to be built with string concatenation. Use parameterized queries or a safe query builder.',
  },
  {
    id: 'dvalin/dom-html-injection',
    name: 'Unsafe HTML injection sink',
    severity: 'warning',
    securitySeverity: '6.1',
    tags: ['security', 'xss', 'cwe-079'],
    helpUri: 'https://cwe.mitre.org/data/definitions/79.html',
    pattern: /\b(innerHTML|outerHTML)\s*=|dangerouslySetInnerHTML\s*=/,
    message: (match) => `Potential XSS sink via ${match[1] ?? 'dangerouslySetInnerHTML'}. Prefer safe text APIs or sanitized, trusted HTML.`,
  },
  {
    id: 'dvalin/eval',
    name: 'Dynamic code execution',
    severity: 'warning',
    securitySeverity: '7.5',
    tags: ['security', 'code-injection', 'cwe-094'],
    helpUri: 'https://cwe.mitre.org/data/definitions/94.html',
    pattern: /\beval\s*\(/,
    message: () => 'Dynamic code execution detected. Replace eval with a constrained parser or explicit command mapping.',
  },
  {
    id: 'dvalin/shell-command-injection',
    name: 'Shell command built from user-controlled input',
    severity: 'error',
    securitySeverity: '8.8',
    tags: ['security', 'command-injection', 'cwe-078'],
    helpUri: 'https://cwe.mitre.org/data/definitions/78.html',
    pattern: /\b(exec|execSync)\s*\([^)\n]*(req\.|process\.argv|input|args)/i,
    message: () => 'Shell execution appears to include user-controlled input. Use execFile/spawn with fixed argv and validation.',
  },
];

function isScannableFile(file: string): boolean {
  const basename = path.basename(file);
  return basename === '.env' || SCANNABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function stableFindingId(parts: string[]): string {
  return parts
    .join(':')
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function snippetFor(lines: string[], lineNumber: number): string {
  const start = Math.max(1, lineNumber - CONTEXT_RADIUS);
  const end = Math.min(lines.length, lineNumber + CONTEXT_RADIUS);
  return lines
    .slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

function isLikelyPlaceholder(line: string): boolean {
  return /\b(example|sample|fixture|placeholder|dummy|changeme|fake|invalid|do[-_]?not[-_]?log|your[-_]?key|not[-_]?real|test[-_]?only)\b/i.test(line);
}

function isBenignSecretLikeValue(rule: LocalRule, match: RegExpMatchArray): boolean {
  if (rule.id !== 'dvalin/hardcoded-secret') return false;
  const value = match[2] ?? '';
  return /^(0+|1+|x+|X+)$/.test(value) || /^[0-9]{12,}$/.test(value);
}

async function readScannableFile(cwd: string, file: string): Promise<string | undefined> {
  const absolute = path.join(cwd, file);
  try {
    const content = await readFile(absolute, 'utf8');
    return Buffer.byteLength(content, 'utf8') <= MAX_FILE_BYTES ? content : undefined;
  } catch {
    return undefined;
  }
}

export async function runLocalSecurityScan(cwd: string): Promise<SarifImportResult> {
  const ignore = [...DEFAULT_IGNORES, ...(await loadIgnorePatterns(cwd))];
  const files = (await fg('**/*', {
    cwd,
    dot: true,
    onlyFiles: true,
    ignore,
    followSymbolicLinks: false,
  }))
    .filter(isScannableFile)
    .sort();

  const findings: RemediationFinding[] = [];
  let totalResults = 0;
  let skippedResults = Math.max(0, files.length - MAX_FILES);

  for (const file of files.slice(0, MAX_FILES)) {
    const content = await readScannableFile(cwd, file);
    if (content === undefined) {
      skippedResults += 1;
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const [lineIndex, line] of lines.entries()) {
      if (findings.length >= MAX_FINDINGS) {
        skippedResults += 1;
        continue;
      }

      if (isLikelyPlaceholder(line)) continue;

      for (const rule of RULES) {
        const match = line.match(rule.pattern);
        if (!match) continue;
        if (isBenignSecretLikeValue(rule, match)) continue;

        totalResults += 1;
        const startLine = lineIndex + 1;
        const baseFinding = {
          id: stableFindingId(['LocalScan', rule.id, file, String(startLine), line.trim().slice(0, 80)]),
          source: 'Dvalin Local Scan',
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          securitySeverity: rule.securitySeverity,
          message: rule.message(match),
          path: file,
          startLine,
          endLine: startLine,
          helpUri: rule.helpUri,
          tags: rule.tags,
          snippet: snippetFor(lines, startLine),
        } satisfies Omit<RemediationFinding, 'prompt'>;

        findings.push({
          ...baseFinding,
          prompt: buildRemediationPrompt(baseFinding),
        });
      }
    }
  }

  return {
    source: 'Dvalin Local Scan',
    findings,
    totalResults,
    skippedResults,
  };
}
