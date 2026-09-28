export const MAX_RECONNECT_BACKOFF_MS = 30_000;
/** Catches updates missed by the live connection. */
export const PERIODIC_STATE_VECTOR_SYNC_MS = 5 * 60_000;
/** Absorbs brief reconnects before announcing that someone left. */
export const PRESENCE_LEAVE_GRACE_MS = 1_000;
export const INITIAL_NETWORK_SYNC_TIMEOUT_MS = 3_000;
/** Bump to discard every cached offline document. */
export const OFFLINE_NAMESPACE_VERSION = 'obsync:v3';
