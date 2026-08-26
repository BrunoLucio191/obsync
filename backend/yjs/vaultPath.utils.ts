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
    throw new Error("A sala Yjs não possui um nome de documento.");
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    throw new Error("O nome da sala Yjs possui codificação inválida.");
  }

  const filePath = normalizeVaultPath(decodedPath);
  const segments = filePath.split("/");

  if (
    !filePath ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("O caminho da sala Yjs é inválido.");
  }

  return {
    docName: encodeURIComponent(filePath),
    filePath,
  };
}
