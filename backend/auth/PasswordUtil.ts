import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/**
 * Hashes a plaintext password with scrypt using a freshly generated random salt.
 * @param password - The plaintext password to hash.
 * @returns A string in the form `"<salt>:<hash>"` (both hex-encoded) suitable for storage.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");

  const passwordNormalized = password.normalize("NFC");

  const hash = (await scryptAsync(passwordNormalized, salt, 64)) as Buffer;

  return `${salt}:${hash.toString("hex")}`;
}

/**
 * Verifies a plaintext password against a stored `"<salt>:<hash>"` string using a
 * timing-safe comparison to avoid leaking information via response time.
 * @param password - The plaintext password to check.
 * @param storedHash - The stored `"<salt>:<hash>"` value to check against.
 * @returns `true` if the password matches the stored hash, `false` otherwise (including malformed input).
 */
export async function passwordMatches(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;

  const passwordNormalized = password.normalize("NFC");
  const candidate = (await scryptAsync(passwordNormalized, salt, 64)) as Buffer;

  const expected = Buffer.from(hash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}
