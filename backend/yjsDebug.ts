import { WebSocket } from "ws";

export type YjsDebugConnectionContext = {
  readonly connectionId: string;
  readonly channel: "yjs" | "system";
  readonly userId?: number;
  readonly userName?: string;
  readonly userEmail?: string;
  readonly userRole?: "admin" | "user";
};

const connectionContexts = new WeakMap<WebSocket, YjsDebugConnectionContext>();

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
