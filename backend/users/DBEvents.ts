import EventEmitter from "node:events";

/**
 * Process-wide emitter used to broadcast user authorization changes (role,
 * active status, etc.) to any part of the backend that needs to react,
 * such as invalidating cached permissions or dropping live connections.
 */
const events = new EventEmitter();

/**
 * Factory returning a small typed facade over the shared {@link events}
 * emitter, scoped to authorization-change notifications for user records.
 *
 * @returns An object exposing a subscribe method and an emit method for
 * the "authorization-changed" event.
 */
export function dbEvents() {

  return {
    /**
     * Subscribes to authorization changes for any user.
     *
     * @param listener - Callback invoked with the affected user's id.
     * @returns An unsubscribe function that removes the listener.
     */
    onAuthorizationChanged(listener: (userId: number) => void): () => void {
      events.on("authorization-changed", listener);
      return () => events.off("authorization-changed", listener);
    },
    /**
     * Notifies subscribers that a user's authorization (role or active
     * status) has changed.
     *
     * @param userId - id of the user whose authorization changed.
     */
    emitAuthorizationChanged(userId: number): void {
      events.emit("authorization-changed", userId);
    },
  };
}
