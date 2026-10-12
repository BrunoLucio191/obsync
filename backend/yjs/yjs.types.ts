import type * as Y from "yjs";

export type YjsPersistenceAdapter = {
  bindState: (filePath: string, ydoc: Y.Doc) => Promise<void>;
  writeState: (filePath: string, ydoc: Y.Doc) => Promise<void>;
  destroyState?: (filePath: string, ydoc: Y.Doc) => Promise<void> | void;
  deleteStateUnderPath?: (filePath: string) => Promise<void>;
  renameStatePath?: (oldPath: string, newPath: string) => Promise<void>;
  updateState: (filePath: string, update: string | Uint8Array) => Promise<void>;
};

export type YjsAuthenticatedConnection = {
  readonly userId: number;
  readonly userName: string;
  readonly userEmail: string;
  readonly userRole: "admin" | "user";
};

export type YjsConnectionState = {
  readonly controlledAwarenessIds: Set<number>;
  readonly authenticatedPresenceId: string;
  readonly userId: number;
  readonly userRole: "admin" | "user";
  readonly canWriteGlobal: boolean;
  closed: boolean;
};

export type YjsAwarenessEntry = {
  readonly clientId: number;
  readonly clock: number;
  readonly state: unknown;
};

export type YjsDocumentIdentity = {
  readonly docName: string;
  readonly filePath: string;
};
