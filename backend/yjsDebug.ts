import { WebSocket } from "ws";

/**
 * Identifying/debugging metadata attached to a WebSocket connection so that
 * logs and diagnostics can be traced back to a specific connection, channel,
 * and (if authenticated) user.
 */
export type YjsDebugConnectionContext = {
  readonly connectionId: string;
  readonly channel: "yjs" | "system";
  readonly userId?: number;
  readonly userName?: string;
  readonly userEmail?: string;
  readonly userRole?: "admin" | "user";
};

/**
 * Associates debug context with a WebSocket connection for later retrieval
 * via {@link getYjsDebugConnection}. Storage is a `WeakMap` so entries are
 * garbage-collected automatically once the connection is no longer
 * referenced elsewhere.
 *
 * @param connection - The WebSocket connection to tag.
 * @param context - Debug metadata to associate with the connection.
 */
export function registerYjsDebugConnection(
  connection: WebSocket,
  context: YjsDebugConnectionContext,
): void {
  connectionContexts.set(connection, context);
}

const connectionContexts = new WeakMap<WebSocket, YjsDebugConnectionContext>();

/**
 * Retrieves the debug context previously registered for a connection via
 * {@link registerYjsDebugConnection}.
 *
 * @param connection - The WebSocket connection to look up.
 * @returns The connection's debug context, or a fallback `{ connectionId: "unknown", channel: "yjs" }` if none was registered.
 */
export function getYjsDebugConnection(
  connection: WebSocket,
): YjsDebugConnectionContext {
  return (
    connectionContexts.get(connection) ?? {
      connectionId: "unknown",
      channel: "yjs",
    }
  );
}
