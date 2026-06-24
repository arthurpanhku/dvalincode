import { canonicalJSON, sha256 } from './hash.js';

export type Fingerprint = {
  sha256: string;
  bytes: number;
};

/** Hash sensitive input before it crosses the persistence boundary. */
export function fingerprint(value: unknown): Fingerprint {
  const serialized = serialize(value);
  return {
    sha256: sha256(serialized),
    bytes: Buffer.byteLength(serialized, 'utf8'),
  };
}

/** A stable descriptor that proves identity without retaining the original text. */
export function minimizedDescriptor(value: unknown): string {
  const fp = fingerprint(value);
  return `minimized sha256:${fp.sha256} bytes:${fp.bytes}`;
}

/** Tool-specific summaries retain useful structure but never content-bearing values. */
export function summarizeToolInput(tool: string, input: unknown): string {
  const fp = fingerprint(input);
  const record = isRecord(input) ? input : {};
  const base = { sha256: fp.sha256, bytes: fp.bytes };

  if (tool === 'shell' || tool === 'run_check') {
    return JSON.stringify({
      ...base,
      executable: stringValue(record.command) ?? stringValue(record.script) ?? 'unknown',
      argsCount: Array.isArray(record.args) ? record.args.length : 0,
    });
  }

  const filePath = stringValue(record.filePath) ?? stringValue(record.path);
  if (filePath) {
    return JSON.stringify({
      ...base,
      filePath,
      contentBytes: byteLength(record.content),
      oldBytes: byteLength(record.oldString),
      newBytes: byteLength(record.newString),
    });
  }

  return JSON.stringify({
    ...base,
    fields: Object.keys(record).sort(),
  });
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return canonicalJSON(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function byteLength(value: unknown): number | undefined {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : undefined;
}
