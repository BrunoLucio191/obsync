/** Upper bound (ms) on the exponential backoff `y-websocket` uses between reconnect attempts. */
export const MAX_RECONNECT_BACKOFF_MS = 30_000;
/** Interval (ms) at which the Yjs provider re-syncs state vectors with the server, to catch missed updates. */
export const PERIODIC_STATE_VECTOR_SYNC_MS = 5 * 60_000;
/** Grace period (ms) to wait after a user's last awareness client disappears before announcing they left, to absorb brief reconnects. */
export const PRESENCE_LEAVE_GRACE_MS = 1_000;
/** Timeout (ms) allowed for the initial network sync to complete when opening a collab room. */
export const INITIAL_NETWORK_SYNC_TIMEOUT_MS = 3_000;
/** Palette used to deterministically assign a cursor/presence color to each collaborator. */
export const Colors = ['#e74c3c', '#2ecc71', '#3498db', '#9b59b6', '#f39c12'];
/** Version tag prefixed to offline IndexedDB namespace names; bump to invalidate previously cached offline documents. */
export const OFFLINE_NAMESPACE_VERSION = 'obsync:v3';
