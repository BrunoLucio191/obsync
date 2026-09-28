export function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decode<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}
