import EventEmitter from "node:events";

/** Lets the backend react to role or status changes, e.g. by dropping live connections. */
const events = new EventEmitter();

export function dbEvents() {
  return {
    onAuthorizationChanged(listener: (userId: number) => void): () => void {
      events.on("authorization-changed", listener);
      return () => events.off("authorization-changed", listener);
    },
    emitAuthorizationChanged(userId: number): void {
      events.emit("authorization-changed", userId);
    },
  };
}
