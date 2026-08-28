/** Hard cap on the size of a single WebSocket message accepted by the Yjs protocol, in bytes. */
export const MAX_WS_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Top-level message type for a `y-protocols/sync` payload (document sync steps/updates). */
export const MESSAGE_SYNC = 0;
/** Top-level message type for a `y-protocols/awareness` payload (cursor/presence updates). */
export const MESSAGE_AWARENESS = 1;
/** Top-level message type reserved for in-protocol auth messages; explicitly rejected, since auth happens at the WebSocket handshake. */
export const MESSAGE_AUTH = 2;
/** Top-level message type for a client requesting a full awareness snapshot of the room. */
export const MESSAGE_QUERY_AWARENESS = 3;

/** Maximum number of messages that may be queued for sequential processing on a single document before the connection is dropped. */
export const MAX_PENDING_MESSAGES_PER_DOCUMENT = 1_024;
/** Maximum number of awareness entries allowed in a single awareness update message. */
export const MAX_AWARENESS_ENTRIES_PER_MESSAGE = 128;
