/** High-confidence credential formats found in tool text before model egress. */
const patterns: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|tvly-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{15,}|AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/g,
  /(?<=(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)["']?\s*[:=]\s*["']?)[A-Za-z0-9+/=_-]{16,}/gi,
];

export function redactToolText(value: string): { text: string; count: number } {
  let count = 0;
  for (const pattern of patterns) {
    value = value.replace(pattern, () => {
      count++;
      return '[redacted credential]';
    });
  }
  return { text: value, count };
}
