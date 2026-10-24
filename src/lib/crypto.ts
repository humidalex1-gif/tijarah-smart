import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { ServiceError } from "@/services/errors";

/**
 * Symmetric encryption for third-party credentials held in the database.
 *
 * The key is derived from `AUTH_SECRET`, which NextAuth already requires, so
 * enabling a feature that stores a credential never asks the owner to edit a
 * file. The salt is a constant and is NOT a secret: its only job is to keep
 * this key distinct from any other use of `AUTH_SECRET`.
 *
 * This does not defend against an attacker who already holds the machine —
 * they have `.env` too. It defends against the far likelier accident: `dev.db`
 * is the file that gets copied for a backup, moved between machines, or
 * attached to a bug report. `.env` is not.
 */

// scrypt is deliberately slow, so derive once per process rather than per call.
let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new ServiceError("CRYPTO_UNREADABLE");
  cachedKey = scryptSync(secret, "salla-connection-v1", 32);
  return cachedKey;
}

/**
 * Returns `v1.<iv>.<tag>.<ciphertext>`, all base64.
 *
 * The version prefix is what makes the scheme replaceable later without having
 * to guess how any given row was written.
 */
export function encryptSecret(plain: string): string {
  // GCM takes a 96-bit nonce, fresh per encryption. Reusing one with the same
  // key is the single catastrophic mistake available in this mode.
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    data.toString("base64"),
  ].join(".");
}

/**
 * Throws `ServiceError("CRYPTO_UNREADABLE")` for anything that does not
 * authenticate — tampering, a truncated row, or a changed `AUTH_SECRET`.
 *
 * Callers must turn that into "re-enter your credentials". It is a recoverable
 * state, not a crash: the owner can always paste the values again.
 */
export function decryptSecret(payload: string): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !data) {
    throw new ServiceError("CRYPTO_UNREADABLE");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    // Set before final(): this is the check that makes tampering fail loudly
    // rather than returning plausible-looking garbage.
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ServiceError("CRYPTO_UNREADABLE");
  }
}
