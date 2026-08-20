import EventEmitter from "node:events";

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
