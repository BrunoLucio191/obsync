import { type IncomingMessage } from "node:http";
import type { YjsDocumentIdentity } from "../yjs.types.ts";

/**
 * Converts a vault path into a canonical form (forward slashes, no leading/trailing slashes)
 * so paths coming from different OSes or with incidental slashes compare equal.
 * @param value - Raw vault path to normalize.
 * @returns The normalized path.
 */
export function normalizeVaultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Checks whether `candidate` is exactly `root` or a path nested underneath it.
 * Used to test whether a document falls under a deleted/renamed folder.
 * @param root - Normalized ancestor path (e.g. a deleted folder).
 * @param candidate - Normalized path being tested.
 * @returns `true` if `candidate` equals `root` or is a descendant of it.
 */
export function isSamePathOrChild(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * Derives the document/room identity for an incoming Yjs WebSocket upgrade request from its URL path.
 * @param request - The raw HTTP upgrade request whose URL encodes the target vault file path.
 * @returns The resolved `docName`/`filePath` pair for the room.
 * @throws If the path is missing, cannot be URI-decoded, or contains `.`/`..` segments.
 */
export function parseDocumentIdentity(request: IncomingMessage): YjsDocumentIdentity {
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

  if (!filePath || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("The Yjs room path is invalid.");
  }

  return {
    docName: encodeURIComponent(filePath),
    filePath,
  };
}
