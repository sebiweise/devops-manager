import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM key ring for tokens stored at rest (design §9).
 *
 * Ciphertext format: `v1:<keyId>:<iv>:<ct>:<tag>`, all parts base64url.
 * `keyId` is derived from the key itself (first 8 bytes of its SHA-256), so a
 * rotated key is found without extra configuration. The current key encrypts;
 * the previous key only decrypts, until a re-encrypt pass has run.
 *
 * `aad` binds a ciphertext to its context (for example the row id and the
 * column), so a value copied into another row does not decrypt.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type KeyRing = {
  encrypt(plaintext: string, aad?: string): string;
  decrypt(ciphertext: string, aad?: string): string;
  /** True when the value was encrypted with a key other than the current one. */
  needsReencrypt(ciphertext: string): boolean;
  currentKeyId: string;
};

function parseKey(base64: string, name: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32)
    throw new Error(`${name} must be 32 bytes, base64 encoded`);
  return key;
}

export function keyIdOf(key: Buffer): string {
  return createHash("sha256")
    .update(key)
    .digest()
    .subarray(0, 8)
    .toString("base64url");
}

export function createKeyRing(
  current: string,
  previous?: string | null,
): KeyRing {
  const currentKey = parseKey(current, "TOKEN_ENCRYPTION_KEY");
  const keys = new Map<string, Buffer>([[keyIdOf(currentKey), currentKey]]);
  if (previous) {
    const prev = parseKey(previous, "TOKEN_ENCRYPTION_KEY_PREVIOUS");
    keys.set(keyIdOf(prev), prev);
  }
  const currentKeyId = keyIdOf(currentKey);

  function split(ciphertext: string) {
    const parts = ciphertext.split(":");
    if (parts.length !== 5 || parts[0] !== VERSION)
      throw new Error("Unsupported ciphertext format");
    const [, keyId, iv, ct, tag] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    return { keyId, iv, ct, tag };
  }

  return {
    currentKeyId,
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", currentKey, iv, {
        authTagLength: TAG_BYTES,
      });
      if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        currentKeyId,
        iv.toString("base64url"),
        ct.toString("base64url"),
        tag.toString("base64url"),
      ].join(":");
    },
    decrypt(ciphertext, aad) {
      const { keyId, iv, ct, tag } = split(ciphertext);
      const key = keys.get(keyId);
      if (!key) throw new Error("Unknown encryption key id");
      const ivBuf = Buffer.from(iv, "base64url");
      const tagBuf = Buffer.from(tag, "base64url");
      if (ivBuf.length !== IV_BYTES || tagBuf.length !== TAG_BYTES) {
        throw new Error("Malformed ciphertext");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, ivBuf, {
        authTagLength: TAG_BYTES,
      });
      if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tagBuf);
      return Buffer.concat([
        decipher.update(Buffer.from(ct, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
    needsReencrypt(ciphertext) {
      return split(ciphertext).keyId !== currentKeyId;
    },
  };
}

/** Decrypts with whatever key matches and encrypts again with the current key. */
export function reencrypt(
  ring: KeyRing,
  ciphertext: string,
  aad?: string,
): string {
  return ring.needsReencrypt(ciphertext)
    ? ring.encrypt(ring.decrypt(ciphertext, aad), aad)
    : ciphertext;
}
