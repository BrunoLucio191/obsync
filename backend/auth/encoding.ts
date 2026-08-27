/**
 * Serializes a plain object to a URL-safe base64 string (used for JWT-like header/payload segments).
 * @param value - The object to serialize.
 * @returns The base64url-encoded JSON representation of `value`.
 */
export function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Decodes a base64url string produced by {@link encode} back into an object.
 * @param value - The base64url-encoded string to decode.
 * @returns The decoded value, cast to type `T`.
 */
export function decode<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}
