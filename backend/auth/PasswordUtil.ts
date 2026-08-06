import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export async function hashPassword(
  this: any,
  password: string,
): Promise<string> {
  const salt = randomBytes(16).toString("hex");

  const passwordNormalized = password.normalize("NFC");

  const hash = (await scryptAsync(passwordNormalized, salt, 64)) as Buffer;

  return `${salt}:${hash.toString("hex")}`;
}

export async function passwordMatches(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;

  const candidate = (await scryptAsync(password, salt, 64)) as Buffer;

  const expected = Buffer.from(hash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}
