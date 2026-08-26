import { type IncomingMessage } from "node:http";
import type { YjsDocumentIdentity } from "./yjs.types.ts";

export function normalizeVaultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function isSamePathOrChild(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function parseDocumentIdentity(
  request: IncomingMessage,
): YjsDocumentIdentity {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const encodedPath = requestUrl.pathname.replace(/^\/+/, "");

  if (!encodedPath) {
    throw new Error("The Yjs room has no document name.");
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    throw new Error("The Yjs room name has invalid encoding.");
  }

  const filePath = normalizeVaultPath(decodedPath);
  const segments = filePath.split("/");

  if (
    !filePath ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("The Yjs room path is invalid.");
  }

  return {
    docName: encodeURIComponent(filePath),
    filePath,
  };
}
