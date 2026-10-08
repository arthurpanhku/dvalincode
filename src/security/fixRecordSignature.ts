import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJSON, sha256 } from '../audit/hash.js';
import { UsageError } from '../core/exitCodes.js';

/**
 * Signatures over a Verified Fix Record.
 *
 * `recordHash` makes a record tamper-*evident*: anyone can recompute it, so an
 * edit that leaves it stale is caught. It cannot say who issued the record. A
 * party that never ran a verification can write a self-consistent record — a
 * passing exit code, a matching hash, a verdict that re-derives — and offline
 * re-derivation will accept it, because there is nothing in the record a
 * forger could not compute.
 *
 * A signature answers the question re-derivation cannot: *which key vouched for
 * this record.* It answers nothing more. A valid signature from a key nobody
 * trusts is a fact about the file, not a reason to believe it; trust comes from
 * the reader naming the keys it accepts (`--trusted-key`), typically the key
 * held by the CI job that re-executed the verification itself.
 *
 * What is signed is the record hash, not the record. The hash already commits
 * to every field, so signing it binds the signature to the whole record without
 * a second canonicalization rule that two implementations could disagree on.
 */
export const FIX_RECORD_SIGNATURE_CONTEXT = 'dvalin-fix-record-signature/v1';

export type FixRecordSignature = {
  alg: 'ed25519';
  /** `sha256:` + hex SHA-256 of the public key's SPKI DER encoding. */
  keyId: string;
  /** Base64 SPKI DER. Carried so a reader can check the signature offline; trust is still the reader's call. */
  publicKey: string;
  signedAt: string;
  /** Base64 Ed25519 signature over `signaturePayload(...)`. */
  signature: string;
};

export type FixRecordSignatureCheck = {
  keyId: string;
  signedAt?: string;
  /** The signature is cryptographically valid over this record's hash. */
  valid: boolean;
  /** The key is one the reader named as trusted. Never true when `valid` is false. */
  trusted: boolean;
  problem?: string;
};

export type TrustedKey = { keyId: string; source: string };

const KEY_ID = /^sha256:[0-9a-f]{64}$/;
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g;

/** The exact bytes a signature covers. Domain-separated so it cannot be replayed as another Dvalin signature. */
export function signaturePayload(input: { recordHash: string; keyId: string; signedAt: string }): Buffer {
  return Buffer.from(canonicalJSON({
    context: FIX_RECORD_SIGNATURE_CONTEXT,
    recordHash: input.recordHash,
    keyId: input.keyId,
    signedAt: input.signedAt,
  }), 'utf8');
}

export function publicKeyId(key: KeyObject): string {
  return `sha256:${sha256(key.export({ type: 'spki', format: 'der' }))}`;
}

export function generateSigningKeyPair(): { privateKeyPem: string; publicKeyPem: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: publicKeyId(publicKey),
  };
}

/** Parse an Ed25519 private key from PEM text. Any other key type is refused rather than silently used. */
export function parseSigningKey(pem: string, source = 'signing key'): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new UsageError(`Cannot read ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new UsageError(`${source} is a ${key.asymmetricKeyType ?? 'non-asymmetric'} key; fix records are signed with Ed25519 only.`);
  }
  return key;
}

/**
 * The signing key for this process, if one was configured.
 *
 * An explicit file wins; then `DVALIN_SIGNING_KEY` (PEM text — the shape a CI
 * secret takes); then `DVALIN_SIGNING_KEY_FILE`. No key configured is not an
 * error: an unsigned record is still a valid, re-derivable record.
 */
export function resolveSigningKey(explicitFile?: string, env: NodeJS.ProcessEnv = process.env): KeyObject | undefined {
  if (explicitFile) return parseSigningKey(readKeyFile(explicitFile), explicitFile);
  const inline = env.DVALIN_SIGNING_KEY?.trim();
  if (inline) return parseSigningKey(inline, 'DVALIN_SIGNING_KEY');
  const file = env.DVALIN_SIGNING_KEY_FILE?.trim();
  if (file) return parseSigningKey(readKeyFile(file), file);
  return undefined;
}

/**
 * Resolve the signing key, then remove it from this process's environment.
 *
 * For any command that runs project checks before signing. Checks are the
 * change under review's own code — its tests, its build — and they inherit this
 * process's environment. A key left in `DVALIN_SIGNING_KEY` while they run is a
 * key the reviewed change can read and use to sign whatever it likes. Taken
 * into memory here, it never reaches a child process.
 */
export function takeSigningKey(explicitFile?: string, env: NodeJS.ProcessEnv = process.env): KeyObject | undefined {
  const key = resolveSigningKey(explicitFile, env);
  delete env.DVALIN_SIGNING_KEY;
  delete env.DVALIN_SIGNING_KEY_FILE;
  return key;
}

/**
 * Sign a record's hash. Returns a new record; the input is not modified.
 *
 * `recordHash` excludes `signatures`, so adding one does not change the hash
 * and a record can carry several (an issuer's and a CI re-verifier's). A second
 * signature by the same key replaces the first.
 */
export function signFixRecord<T extends { recordHash: string; signatures?: FixRecordSignature[] }>(
  record: T,
  privateKey: KeyObject,
  options: { signedAt?: string } = {},
): T {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new UsageError('Fix records are signed with Ed25519 only.');
  const publicKey = createPublicKey(privateKey);
  const keyId = publicKeyId(publicKey);
  const signedAt = options.signedAt ?? new Date().toISOString();
  const signature: FixRecordSignature = {
    alg: 'ed25519',
    keyId,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    signedAt,
    signature: signBytes(null, signaturePayload({ recordHash: record.recordHash, keyId, signedAt }), privateKey).toString('base64'),
  };
  const others = (record.signatures ?? []).filter(existing => existing.keyId !== keyId);
  return { ...record, signatures: [...others, signature] };
}

/** Check every signature a record carries against its hash, and against the reader's trusted keys. */
export function checkFixRecordSignatures(
  record: { recordHash: string; signatures?: unknown },
  trustedKeys: TrustedKey[] = [],
): FixRecordSignatureCheck[] {
  const signatures = Array.isArray(record.signatures) ? record.signatures : [];
  const trusted = new Set(trustedKeys.map(key => key.keyId));
  return signatures.map((value): FixRecordSignatureCheck => {
    if (!isSignatureShape(value)) {
      const keyId = value && typeof value === 'object' && typeof (value as Record<string, unknown>).keyId === 'string'
        ? String((value as Record<string, unknown>).keyId)
        : 'unknown';
      return { keyId, valid: false, trusted: false, problem: 'malformed signature entry' };
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: Buffer.from(value.publicKey, 'base64'), format: 'der', type: 'spki' });
    } catch {
      return { keyId: value.keyId, signedAt: value.signedAt, valid: false, trusted: false, problem: 'public key does not parse' };
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      return { keyId: value.keyId, signedAt: value.signedAt, valid: false, trusted: false, problem: 'public key is not Ed25519' };
    }
    // The key id is a claim too. A signature that names one key and carries
    // another must not be able to borrow the named key's trust.
    if (publicKeyId(publicKey) !== value.keyId) {
      return { keyId: value.keyId, signedAt: value.signedAt, valid: false, trusted: false, problem: 'keyId does not match the embedded public key' };
    }
    let valid = false;
    try {
      valid = verifyBytes(
        null,
        signaturePayload({ recordHash: record.recordHash, keyId: value.keyId, signedAt: value.signedAt }),
        publicKey,
        Buffer.from(value.signature, 'base64'),
      );
    } catch {
      valid = false;
    }
    return {
      keyId: value.keyId,
      signedAt: value.signedAt,
      valid,
      trusted: valid && trusted.has(value.keyId),
      ...(valid ? {} : { problem: 'signature does not verify against this record' }),
    };
  });
}

/**
 * Resolve trusted-key specs into key ids.
 *
 * A spec is a `sha256:<hex>` key id, a path to a PEM public key, or PEM text
 * (possibly several blocks — the shape an environment variable takes). The key
 * id is a hash of the whole public key, so pinning the id pins the key.
 */
export function resolveTrustedKeys(specs: string[], env: NodeJS.ProcessEnv = process.env): TrustedKey[] {
  const all = [...specs];
  const fromEnv = env.DVALIN_TRUSTED_KEYS?.trim();
  if (fromEnv) all.push(fromEnv);

  const keys: TrustedKey[] = [];
  for (const raw of all) {
    const spec = raw.trim();
    if (!spec) continue;
    if (spec.includes('-----BEGIN')) {
      for (const block of spec.match(PEM_BLOCK) ?? []) keys.push({ keyId: publicKeyIdFromPem(block, 'inline PEM'), source: 'inline PEM' });
      continue;
    }
    // Env values and repeated flags may still be comma or whitespace separated.
    for (const part of spec.split(/[\s,]+/).filter(Boolean)) {
      if (KEY_ID.test(part)) keys.push({ keyId: part, source: part });
      else keys.push({ keyId: publicKeyIdFromPem(readKeyFile(part), part), source: part });
    }
  }
  const seen = new Set<string>();
  return keys.filter(key => (seen.has(key.keyId) ? false : (seen.add(key.keyId), true)));
}

export function isSignatureShape(value: unknown): value is FixRecordSignature {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const signature = value as Record<string, unknown>;
  return signature.alg === 'ed25519'
    && typeof signature.keyId === 'string'
    && KEY_ID.test(signature.keyId)
    && typeof signature.publicKey === 'string'
    && typeof signature.signedAt === 'string'
    && typeof signature.signature === 'string';
}

function publicKeyIdFromPem(pem: string, source: string): string {
  try {
    // A private key also yields its public half; accept it so a key file
    // pointed at by mistake still resolves to the right id.
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new UsageError(`${source} is not an Ed25519 public key.`);
    return publicKeyId(key);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read trusted key ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readKeyFile(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new UsageError(`Cannot read key file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
