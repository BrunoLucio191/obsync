import EventEmitter from "node:events";

export function dbEvents(userId: number | undefined = undefined) {
  const events = new EventEmitter();

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
