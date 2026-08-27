import type * as Y from "yjs";

/**
 * Pluggable storage backend for Yjs documents, injected into {@link YjsPersistenceGateway}.
 * Implementations are responsible for loading/saving CRDT state and reacting to vault path changes.
 */
export type YjsPersistenceAdapter = {
  /**
   * Loads persisted state (if any) into `ydoc` and/or wires it up to receive future updates.
   * @param docName - Encoded document identifier used as the storage key.
   * @param ydoc - The in-memory Yjs document to hydrate.
   */
  bindState: (docName: string, ydoc: Y.Doc) => Promise<void>;
  /**
   * Persists the current state of `ydoc` to storage.
   * @param docName - Encoded document identifier used as the storage key.
   * @param ydoc - The in-memory Yjs document whose state should be saved.
   */
  writeState: (docName: string, ydoc: Y.Doc) => Promise<void>;
  /**
   * Releases any resources the adapter holds for this document (called after the room is torn down).
   * @param docName - Encoded document identifier used as the storage key.
   * @param ydoc - The in-memory Yjs document being discarded.
   */
  destroyState?: (docName: string, ydoc: Y.Doc) => Promise<void> | void;
  /**
   * Deletes persisted state for a path and everything nested under it (e.g. a deleted folder).
   * @param targetPath - Normalized vault path that was deleted.
   */
  deleteStateUnderPath?: (targetPath: string) => Promise<void>;
  /**
   * Moves persisted state from one vault path to another (e.g. a rename/move).
   * @param oldPath - Normalized vault path being moved from.
   * @param newPath - Normalized vault path being moved to.
   */
  renameStatePath?: (oldPath: string, newPath: string) => Promise<void>;
};

/** Identity of a user resolved from the authenticated WebSocket handshake, before a room-specific session is created. */
export type YjsAuthenticatedConnection = {
  /** Numeric database id of the authenticated user. */
  readonly userId: number;
  /** Display name of the authenticated user. */
  readonly userName: string;
  /** Email of the authenticated user; also used as the awareness presence identity. */
  readonly userEmail: string;
  /** Authorization role, used to gate write access to shared documents. */
  readonly userRole: "admin" | "user";
};

/** Per-connection state tracked for the lifetime of a single WebSocket's membership in a {@link YjsRoom}. */
export type YjsConnectionState = {
  /** Awareness client ids currently owned/controlled by this connection. */
  readonly controlledAwarenessIds: Set<number>;
  /** Normalized presence identity (lowercased email) this connection is authorized to broadcast awareness as. */
  readonly authenticatedPresenceId: string;
  /** Numeric database id of the connection's authenticated user. */
  readonly userId: number;
  /** Authorization role of the connection's authenticated user. */
  readonly userRole: "admin" | "user";
  /** Whether this connection is allowed to apply document updates (currently true only for admins). */
  readonly canWriteGlobal: boolean;
  /** Set once the connection has been released, to short-circuit any messages still in flight. */
  closed: boolean;
};

/** A single decoded entry from a `y-protocols/awareness` update payload. */
export type YjsAwarenessEntry = {
  /** Yjs awareness client id the entry belongs to. */
  readonly clientId: number;
  /** Logical clock of the entry, used by the awareness protocol to order updates. */
  readonly clock: number;
  /** Arbitrary JSON-decoded awareness state (`null` signals removal of the client id). */
  readonly state: unknown;
};

/** Result of resolving a WebSocket upgrade request's URL into a concrete document/room identity. */
export type YjsDocumentIdentity = {
  /** URI-encoded form of `filePath`, used as the room registry key and persistence storage key. */
  readonly docName: string;
  /** Normalized vault-relative file path the document represents. */
  readonly filePath: string;
};
