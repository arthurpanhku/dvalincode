import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixRecord, fixRecordHash, verifyFixRecord, type FixRecordInput } from '../src/security/fixRecord.js';
import {
  checkFixRecordSignatures,
  generateSigningKeyPair,
  parseSigningKey,
  resolveTrustedKeys,
  signFixRecord,
  takeSigningKey,
} from '../src/security/fixRecordSignature.js';
import { renderSignatureSummary } from '../src/security/fixRecordFile.js';
import type { SecurityCoverage } from '../src/security/contracts.js';

const complete: SecurityCoverage = {
  status: 'complete',
  scanners: [{ id: 'builtin', status: 'completed' }],
  exclusions: [],
  deferred: [],
  notes: [],
};

function input(overrides: Partial<FixRecordInput> = {}): FixRecordInput {
  return {
    projectId: 'abc123',
    executor: 'claude-code',
    before: {
      scanId: 'scan-a',
      completedAt: '2026-01-01T00:00:00Z',
      coverage: complete,
      targets: [{
        fingerprint: 'fp-1',
        targetFingerprint: 'tfp-1',
        findingId: 'one',
        source: 'Dvalin Local Scan',
        scanner: 'builtin',
        ruleId: 'dvalin/eval',
        severity: 'error',
        message: 'eval on user input',
        path: 'src/app.ts',
        startLine: 4,
        tags: [],
      }],
    },
    after: { scanId: 'scan-b', completedAt: '2026-01-01T00:10:00Z', coverage: complete, remainingTargets: [] },
    regression: { gate: { threshold: 'high', mode: 'new' }, introduced: [] },
    checks: [{ kind: 'test', command: 'npm test', exitCode: 0, passed: true }],
    generatedAt: '2026-01-01T00:11:00Z',
    version: '0.22.0',
    ...overrides,
  };
}

const ci = generateSigningKeyPair();
const other = generateSigningKeyPair();
const ciKey = parseSigningKey(ci.privateKeyPem);
const otherKey = parseSigningKey(other.privateKeyPem);

describe('signing a fix record', () => {
  it('does not change the record hash, so existing records and signed ones hash alike', () => {
    const record = buildFixRecord(input());
    const signed = signFixRecord(record, ciKey);
    expect(signed.recordHash).toBe(record.recordHash);
    expect(fixRecordHash(signed)).toBe(record.recordHash);
    expect(signed.signatures).toHaveLength(1);
    expect(signed.signatures![0]!.keyId).toBe(ci.keyId);
  });

  it('re-derives with a valid signature, and reports it as untrusted when no key is named', () => {
    const signed = signFixRecord(buildFixRecord(input()), ciKey);
    const check = verifyFixRecord(signed);
    expect(check.ok).toBe(true);
    expect(check.signatures).toEqual([expect.objectContaining({ keyId: ci.keyId, valid: true, trusted: false })]);
    expect(renderSignatureSummary(check.signatures!)).toMatch(/no trusted key was named/);
  });

  it('is trusted only when the reader names the key', () => {
    const signed = signFixRecord(buildFixRecord(input()), ciKey);
    const trusted = verifyFixRecord(signed, { trustedKeys: [{ keyId: ci.keyId, source: 'test' }] });
    expect(trusted.ok).toBe(true);
    expect(trusted.signatures![0]!.trusted).toBe(true);

    const wrongKey = verifyFixRecord(signed, { trustedKeys: [{ keyId: other.keyId, source: 'test' }] });
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.reasons).toContain('no signature on this record is from a trusted key');
  });

  it('fails an unsigned record when the reader requires a trusted signature', () => {
    // The forgery re-derivation alone cannot catch: a self-consistent record
    // written by someone who never ran anything.
    const forged = buildFixRecord(input());
    expect(verifyFixRecord(forged).ok).toBe(true);
    const check = verifyFixRecord(forged, { trustedKeys: [{ keyId: ci.keyId, source: 'test' }] });
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain('the record is unsigned, and a signature from a trusted key is required');
  });

  it('invalidates the signature when the record is edited and re-hashed after signing', () => {
    const signed = signFixRecord(buildFixRecord(input()), ciKey);
    // A forger who edits the evidence, re-derives the verdict, and recomputes
    // the hash leaves a self-consistent record — but not one the key signed.
    const edited = buildFixRecord(input({ checks: [{ kind: 'test', command: 'true', exitCode: 0, passed: true }] }));
    const transplanted = { ...edited, signatures: signed.signatures };
    const check = verifyFixRecord(transplanted, { trustedKeys: [{ keyId: ci.keyId, source: 'test' }] });
    expect(check.ok).toBe(false);
    expect(check.reasons.some(reason => reason.includes('is invalid'))).toBe(true);
  });

  it('fails a signature that names a trusted key id but carries a different public key', () => {
    const signedByOther = signFixRecord(buildFixRecord(input()), otherKey);
    const forged = {
      ...signedByOther,
      signatures: [{ ...signedByOther.signatures![0]!, keyId: ci.keyId }],
    };
    const [result] = checkFixRecordSignatures(forged, [{ keyId: ci.keyId, source: 'test' }]);
    expect(result).toMatchObject({ valid: false, trusted: false, problem: 'keyId does not match the embedded public key' });
    expect(verifyFixRecord(forged).ok).toBe(false);
  });

  it('carries several signatures, and re-signing with one key replaces its own', () => {
    const record = buildFixRecord(input());
    const twice = signFixRecord(signFixRecord(signFixRecord(record, ciKey), otherKey), ciKey);
    expect(twice.signatures!.map(signature => signature.keyId).sort()).toEqual([ci.keyId, other.keyId].sort());
    expect(verifyFixRecord(twice, { trustedKeys: [{ keyId: other.keyId, source: 'test' }] }).ok).toBe(true);
  });

  it('refuses non-Ed25519 signing keys', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => parseSigningKey(rsa)).toThrow(/Ed25519 only/);
  });
});

describe('key configuration', () => {
  it('resolves trusted keys from a key id, a PEM file, and inline PEM in the environment', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dvalin-keys-'));
    try {
      const pub = path.join(dir, 'ci.pub');
      writeFileSync(pub, ci.publicKeyPem);
      expect(resolveTrustedKeys([pub], {}).map(key => key.keyId)).toEqual([ci.keyId]);
      expect(resolveTrustedKeys([other.keyId], {}).map(key => key.keyId)).toEqual([other.keyId]);
      const fromEnv = resolveTrustedKeys([], { DVALIN_TRUSTED_KEYS: `${ci.publicKeyPem}\n${other.publicKeyPem}` });
      expect(fromEnv.map(key => key.keyId)).toEqual([ci.keyId, other.keyId]);
      // Duplicates collapse.
      expect(resolveTrustedKeys([pub, ci.keyId], {})).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the signing key out of the environment so the checks it precedes cannot read it', () => {
    const env: NodeJS.ProcessEnv = { DVALIN_SIGNING_KEY: ci.privateKeyPem, DVALIN_SIGNING_KEY_FILE: '/nope' };
    const key = takeSigningKey(undefined, env);
    expect(key?.asymmetricKeyType).toBe('ed25519');
    expect(env.DVALIN_SIGNING_KEY).toBeUndefined();
    expect(env.DVALIN_SIGNING_KEY_FILE).toBeUndefined();
  });

  it('treats no configured key as unsigned, not as an error', () => {
    expect(takeSigningKey(undefined, {})).toBeUndefined();
  });
});
