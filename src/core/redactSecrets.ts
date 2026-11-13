/** High-confidence credential formats found in tool text before model egress. */
const patterns: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|tvly-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{15,}|AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/g,
  /(?<=(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)["']?\s*[:=]\s*["']?)[A-Za-z0-9+/=_-]{16,}/gi,
];

/** What the model sees in place of a credential. */
export const REDACTION_PLACEHOLDER = '[redacted credential]';

export function redactToolText(value: string): { text: string; count: number } {
  let count = 0;
  for (const pattern of patterns) {
    value = value.replace(pattern, () => {
      count++;
      return REDACTION_PLACEHOLDER;
    });
  }
  return { text: value, count };
}

/**
 * Refuse a write that would add redaction placeholders to a file. The model
 * only ever saw the placeholder, so writing it back (a whole-file rewrite of a
 * config it read, say) would replace a real secret with this text. Counting,
 * rather than refusing any occurrence, still allows edits to files that
 * already contain the literal text.
 */
export function assertNoRedactionWriteBack(before: string, after: string, filePath: string): void {
  if (occurrences(after) > occurrences(before)) {
    throw new Error(
      `Refusing to write ${filePath}: the new content adds "${REDACTION_PLACEHOLDER}", which stands in for a secret you were not shown. Writing it would replace the real value. Edit around the secret instead, or ask the user to change it.`,
    );
  }
}

function occurrences(text: string): number {
  return text.split(REDACTION_PLACEHOLDER).length - 1;
}
