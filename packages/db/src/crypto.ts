import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * AES-256-GCM envelope for credentials at rest.
 *
 * The threat this actually addresses is mundane and common: someone copies the
 * SQLite file off the host, or it ends up in a backup. Encryption at rest means
 * the file alone is not enough -- the key lives in the environment, not the DB.
 */
export interface SecretEnvelope {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ct: string;
}

const KEY_BYTES = 32;
let cachedKey: Buffer | null = null;

export function loadMasterKey(raw = process.env.SUPOPS_MASTER_KEY): Buffer {
  if (cachedKey) return cachedKey;
  if (!raw) {
    throw new Error(
      'SUPOPS_MASTER_KEY is not set. Generate one with: openssl rand -base64 32',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SUPOPS_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  cachedKey = key;
  return key;
}

/** Test seam. */
export function setMasterKey(key: Buffer | null): void {
  cachedKey = key;
}

export function encryptSecret(plaintext: string, key = loadMasterKey()): SecretEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decryptSecret(envelope: SecretEnvelope, key = loadMasterKey()): string {
  if (envelope.v !== 1 || envelope.alg !== 'aes-256-gcm') {
    throw new Error(`Unsupported secret envelope: v=${envelope.v} alg=${envelope.alg}`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Stable id for a secret value, used for rotation detection and output redaction. */
export const fingerprintSecret = (plaintext: string): string =>
  createHash('sha256').update(plaintext, 'utf8').digest('hex');

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Serialise for the `secret_enc` column. */
export const packEnvelope = (e: SecretEnvelope): string => JSON.stringify(e);
export const unpackEnvelope = (s: string): SecretEnvelope => JSON.parse(s) as SecretEnvelope;
