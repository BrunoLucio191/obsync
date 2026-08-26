import type * as Y from "yjs";

export type YjsPersistenceAdapter = {
  bindState: (docName: string, ydoc: Y.Doc) => Promise<void>;
  writeState: (docName: string, ydoc: Y.Doc) => Promise<void>;
  destroyState?: (docName: string, ydoc: Y.Doc) => Promise<void> | void;
  deleteStateUnderPath?: (targetPath: string) => Promise<void>;
  renameStatePath?: (oldPath: string, newPath: string) => Promise<void>;
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
