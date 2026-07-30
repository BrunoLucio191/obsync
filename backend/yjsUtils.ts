import { type IncomingMessage } from "node:http";
import { WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { getYjsDebugConnection } from "./yjsDebug.ts";

export const MAX_WS_MESSAGE_BYTES = 16 * 1024 * 1024;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;
const MAX_PENDING_MESSAGES_PER_DOCUMENT = 1_024;
const MAX_AWARENESS_ENTRIES_PER_MESSAGE = 128;

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

type ConnectionState = {
  readonly controlledAwarenessIds: Set<number>;
  readonly authenticatedPresenceId: string;
  readonly userId: number;
  readonly userRole: "admin" | "user";
  readonly canWriteGlobal: boolean;
  closed: boolean;
};

type SharedDocument = {
  readonly docName: string;
  readonly filePath: string;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly connections: Map<WebSocket, ConnectionState>;
  readonly awarenessOwners: Map<number, WebSocket>;
  ready: Promise<void>;
  messageQueue: Promise<void>;
  pendingMessages: number;
  reservations: number;
  closingPromise: Promise<void> | null;
  listenersAttached: boolean;
};

type AwarenessEntry = {
  readonly clientId: number;
  readonly clock: number;
  readonly state: unknown;
};

const documents = new Map<string, SharedDocument>();
const deletedRoots = new Set<string>();
const invalidatedDocuments = new WeakSet<Y.Doc>();

let persistence: YjsPersistenceAdapter | undefined;

function describeConnection(connection: WebSocket): Record<string, unknown> {
  const context = getYjsDebugConnection(connection);
  return {
    connectionId: context.connectionId,
    userId: context.userId,
    userName: context.userName,
    readyState: connection.readyState,
  };
}

function normalizeVaultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isSamePathOrChild(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function parseDocumentIdentity(request: IncomingMessage): {
  docName: string;
  filePath: string;
} {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const encodedPath = requestUrl.pathname.replace(/^\/+/, "");

  if (!encodedPath) {
    throw new Error("A sala Yjs não possui um nome de documento.");
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    throw new Error("O nome da sala Yjs possui codificação inválida.");
  }

  const filePath = normalizeVaultPath(decodedPath);
  const segments = filePath.split("/");

  if (
    !filePath ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("O caminho da sala Yjs é inválido.");
  }

  return {
    docName: encodeURIComponent(filePath),
    filePath,
  };
}

export function isPathDeleted(filePath: string): boolean {
  const normalized = normalizeVaultPath(filePath);

  for (const root of deletedRoots) {
    if (isSamePathOrChild(root, normalized)) return true;
  }

  return false;
}

export function isDocumentInvalidated(doc: Y.Doc): boolean {
  return invalidatedDocuments.has(doc);
}

export function invalidateRoomsUnderPath(targetPath: string): void {
  const normalizedTarget = normalizeVaultPath(targetPath);

  for (const shared of documents.values()) {
    if (!isSamePathOrChild(normalizedTarget, shared.filePath)) continue;

    invalidatedDocuments.add(shared.doc);

    for (const connection of shared.connections.keys()) {
      closeConnection(connection, 1008, "Path deleted");
    }
  }
}

export function markPathDeleted(targetPath: string): void {
  const normalizedTarget = normalizeVaultPath(targetPath);

  for (const root of deletedRoots) {
    if (isSamePathOrChild(normalizedTarget, root)) {
      deletedRoots.delete(root);
    }
  }

  deletedRoots.add(normalizedTarget);
  invalidateRoomsUnderPath(normalizedTarget);
}

export function clearPathDeleted(targetPath: string): void {
  const normalizedTarget = normalizeVaultPath(targetPath);

  for (const root of deletedRoots) {
    if (
      isSamePathOrChild(root, normalizedTarget) ||
      isSamePathOrChild(normalizedTarget, root)
    ) {
      deletedRoots.delete(root);
    }
  }
}

export async function deletePersistedStateUnderPath(
  targetPath: string,
): Promise<void> {
  await persistence?.deleteStateUnderPath?.(normalizeVaultPath(targetPath));
}

export async function renamePersistedStatePath(
  oldPath: string,
  newPath: string,
): Promise<void> {
  await persistence?.renameStatePath?.(
    normalizeVaultPath(oldPath),
    normalizeVaultPath(newPath),
  );
}

function createSharedDocument(
  docName: string,
  filePath: string,
): SharedDocument {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);

  const shared: SharedDocument = {
    docName,
    filePath,
    doc,
    awareness,
    connections: new Map(),
    awarenessOwners: new Map(),
    ready: Promise.resolve(),
    messageQueue: Promise.resolve(),
    pendingMessages: 0,
    reservations: 1,
    closingPromise: null,
    listenersAttached: false,
  };

  documents.set(docName, shared);

  shared.ready = (async () => {
    await persistence?.bindState(docName, doc);
    attachDocumentListeners(shared);
  })().catch((error: unknown) => {
    if (documents.get(docName) === shared) {
      documents.delete(docName);
    }

    for (const connection of shared.connections.keys()) {
      closeConnection(connection, 1011, "Document initialization failed");
    }

    awareness.destroy();
    doc.destroy();
    throw error;
  });

  return shared;
}

function reserveSharedDocument(
  docName: string,
  filePath: string,
): SharedDocument | null {
  const existing = documents.get(docName);

  if (existing) {
    // Uma nova conexão durante o flush final deve reconectar alguns instantes
    // depois, em vez de entrar em uma geração de sala que está sendo destruída.
    if (existing.closingPromise) {
      return null;
    }

    existing.reservations += 1;

    return existing;
  }

  return createSharedDocument(docName, filePath);
}

function attachDocumentListeners(shared: SharedDocument): void {
  if (shared.listenersAttached) return;
  shared.listenersAttached = true;

  shared.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (isDocumentInvalidated(shared.doc)) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(shared, encoding.toUint8Array(encoder));
  });

  shared.awareness.on(
    "update",
    ({
      added,
      updated,
      removed,
    }: {
      added: number[];
      updated: number[];
      removed: number[];
    }) => {
      const changedClients = added.concat(updated, removed);
      if (changedClients.length === 0) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          shared.awareness,
          changedClients,
        ),
      );
      broadcast(shared, encoding.toUint8Array(encoder));
    },
  );
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const merged = Buffer.concat(data);
    return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function send(connection: WebSocket, message: Uint8Array): void {
  if (connection.readyState !== WebSocket.OPEN) return;

  try {
    connection.send(message, { binary: true });
  } catch (error) {
    console.error("[Yjs] Falha ao enviar mensagem WebSocket:", error);
    connection.terminate();
  }
}

function broadcast(shared: SharedDocument, message: Uint8Array): void {
  for (const connection of shared.connections.keys()) {
    send(connection, message);
  }
}

function closeConnection(
  connection: WebSocket,
  code: number,
  reason: string,
): void {
  if (
    connection.readyState === WebSocket.CLOSING ||
    connection.readyState === WebSocket.CLOSED
  ) {
    return;
  }

  try {
    connection.close(code, reason.slice(0, 123));
  } catch {
    connection.terminate();
  }
}

function ensureDecoderConsumed(decoder: decoding.Decoder): void {
  if (decoding.hasContent(decoder)) {
    throw new Error("A mensagem Yjs contém bytes inesperados no final.");
  }
}

function readBoundedByteArray(
  decoder: decoding.Decoder,
  label: string,
): Uint8Array {
  const value = decoding.readVarUint8Array(decoder);

  if (value.byteLength > MAX_WS_MESSAGE_BYTES) {
    throw new Error(`${label} excede o tamanho máximo permitido.`);
  }

  return value;
}

function processSyncMessage(
  shared: SharedDocument,
  connection: WebSocket,
  connectionState: ConnectionState,
  decoder: decoding.Decoder,
): void {
  const syncMessageType = decoding.readVarUint(decoder);

  switch (syncMessageType) {
    case syncProtocol.messageYjsSyncStep1: {
      const remoteStateVector = readBoundedByteArray(decoder, "State Vector");
      ensureDecoderConsumed(decoder);

      const missingForRemote = Y.encodeStateAsUpdate(
        shared.doc,
        remoteStateVector,
      );

      const response = encoding.createEncoder();
      encoding.writeVarUint(response, MESSAGE_SYNC);
      syncProtocol.writeSyncStep2(response, shared.doc, remoteStateVector);
      const responseMessage = encoding.toUint8Array(response);
      send(connection, responseMessage);

      return;
    }

    case syncProtocol.messageYjsSyncStep2:
    case syncProtocol.messageYjsUpdate: {
      const update = readBoundedByteArray(decoder, "Update Yjs");
      ensureDecoderConsumed(decoder);

      if (!connectionState.canWriteGlobal) {
        console.warn("[Audit] Update Yjs global bloqueado", {
          userId: connectionState.userId,
          role: connectionState.userRole,
          operation:
            syncMessageType === syncProtocol.messageYjsSyncStep2
              ? "yjs-sync-step2"
              : "yjs-update",
          path: shared.filePath,
          timestamp: new Date().toISOString(),
          allowed: false,
        });

        return;
      }

      Y.applyUpdate(shared.doc, update, connection);

      return;
    }

    default:
      throw new Error(
        `Tipo interno de sincronização Yjs desconhecido: ${syncMessageType}`,
      );
  }
}

function parseAwarenessEntries(update: Uint8Array): AwarenessEntry[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);

  if (count > MAX_AWARENESS_ENTRIES_PER_MESSAGE) {
    throw new Error("A mensagem de awareness possui entradas demais.");
  }

  const entries: AwarenessEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const stateJson = decoding.readVarString(decoder);

    let state: unknown;
    try {
      state = JSON.parse(stateJson) as unknown;
    } catch {
      throw new Error("Estado de awareness inválido.");
    }

    entries.push({ clientId, clock, state });
  }

  ensureDecoderConsumed(decoder);
  return entries;
}

function normalizePresenceIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function getAwarenessPresenceIdentity(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;

  const user = (state as { user?: { id?: unknown } }).user;
  return normalizePresenceIdentity(user?.id);
}

function encodeAwarenessEntries(
  entries: readonly AwarenessEntry[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);

  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }

  return encoding.toUint8Array(encoder);
}

function validateAndCommitAwarenessOwnership(
  shared: SharedDocument,
  connection: WebSocket,
  connectionState: ConnectionState,
  update: Uint8Array,
): void {
  const entries = parseAwarenessEntries(update);
  const authenticatedPresenceId = connectionState.authenticatedPresenceId;
  const acceptedEntries: AwarenessEntry[] = [];
  const ignoredEntries: Array<Record<string, unknown>> = [];

  for (const entry of entries) {
    const currentOwner = shared.awarenessOwners.get(entry.clientId);

    if (entry.state === null) {
      // O y-websocket pode ecoar snapshots de awareness remoto. Uma conexão
      // só pode remover clientIds que ela realmente controla.
      if (currentOwner !== connection) {
        ignoredEntries.push({
          clientId: entry.clientId,
          reason: "foreign-removal-echo",
          currentOwner: currentOwner ? describeConnection(currentOwner) : null,
        });
        continue;
      }

      acceptedEntries.push(entry);
      continue;
    }

    const presenceId = getAwarenessPresenceIdentity(entry.state);

    // A identidade do awareness precisa ser a mesma identidade autenticada no
    // upgrade HTTP. Isso descarta snapshots remotos reenviados pelo provider,
    // como Bruno enviando acidentalmente o estado de Thiago.
    if (
      authenticatedPresenceId === null ||
      presenceId === null ||
      presenceId !== authenticatedPresenceId
    ) {
      ignoredEntries.push({
        clientId: entry.clientId,
        reason: "remote-awareness-echo",
        presenceId,
        authenticatedPresenceId,
      });
      continue;
    }

    if (currentOwner && currentOwner !== connection) {
      const currentOwnerContext = getYjsDebugConnection(currentOwner);
      const currentOwnerPresenceId = normalizePresenceIdentity(
        currentOwnerContext.userEmail,
      );

      if (currentOwnerPresenceId !== authenticatedPresenceId) {
        // Uma colisão real entre usuários diferentes não deve derrubar nenhum
        // socket nem transferir ownership silenciosamente.
        ignoredEntries.push({
          clientId: entry.clientId,
          reason: "cross-user-client-id-collision",
          currentOwner: describeConnection(currentOwner),
          attemptedOwner: describeConnection(connection),
        });
        continue;
      }

      // Reconexão do mesmo usuário. O ownership pode passar para o socket novo,
      // mas o socket antigo não é fechado: isso evita o ping-pong de conexões.
      shared.connections
        .get(currentOwner)
        ?.controlledAwarenessIds.delete(entry.clientId);
    }

    acceptedEntries.push(entry);
  }

  if (acceptedEntries.length === 0) return;

  const filteredUpdate = encodeAwarenessEntries(acceptedEntries);
  awarenessProtocol.applyAwarenessUpdate(
    shared.awareness,
    filteredUpdate,
    connection,
  );

  for (const entry of acceptedEntries) {
    if (entry.state === null) {
      shared.awarenessOwners.delete(entry.clientId);
      connectionState.controlledAwarenessIds.delete(entry.clientId);
      continue;
    }

    shared.awarenessOwners.set(entry.clientId, connection);
    connectionState.controlledAwarenessIds.add(entry.clientId);
  }
}

function sendAwarenessSnapshot(
  shared: SharedDocument,
  connection: WebSocket,
): void {
  const clientIds = Array.from(shared.awareness.getStates().keys());
  if (clientIds.length === 0) return;

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(shared.awareness, clientIds),
  );
  send(connection, encoding.toUint8Array(encoder));
}

function processIncomingMessage(
  shared: SharedDocument,
  connection: WebSocket,
  connectionState: ConnectionState,
  message: Uint8Array,
): void {
  if (message.byteLength === 0) {
    throw new Error("Mensagem WebSocket Yjs vazia.");
  }

  if (message.byteLength > MAX_WS_MESSAGE_BYTES) {
    closeConnection(connection, 1009, "Message too large");
    return;
  }

  if (isDocumentInvalidated(shared.doc) || isPathDeleted(shared.filePath)) {
    closeConnection(connection, 1008, "Document deleted");
    return;
  }

  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case MESSAGE_SYNC:
      processSyncMessage(shared, connection, connectionState, decoder);
      return;

    case MESSAGE_AWARENESS: {
      const update = readBoundedByteArray(decoder, "Awareness update");
      ensureDecoderConsumed(decoder);
      validateAndCommitAwarenessOwnership(
        shared,
        connection,
        connectionState,
        update,
      );
      return;
    }

    case MESSAGE_QUERY_AWARENESS:
      ensureDecoderConsumed(decoder);

      sendAwarenessSnapshot(shared, connection);
      return;

    case MESSAGE_AUTH:
      throw new Error(
        "Mensagens de autenticação dentro do protocolo Yjs não são aceitas; use o token do upgrade HTTP.",
      );

    default:
      throw new Error(`Tipo de mensagem Yjs desconhecido: ${messageType}`);
  }
}

function enqueueIncomingMessage(
  shared: SharedDocument,
  connection: WebSocket,
  connectionState: ConnectionState,
  message: Uint8Array,
): void {
  shared.pendingMessages += 1;

  if (shared.pendingMessages > MAX_PENDING_MESSAGES_PER_DOCUMENT) {
    shared.pendingMessages -= 1;
    closeConnection(connection, 1013, "Document queue overloaded");
    return;
  }

  const task = shared.messageQueue.then(async () => {
    await shared.ready;

    if (connectionState.closed) return;
    processIncomingMessage(shared, connection, connectionState, message);
  });

  shared.messageQueue = task
    .catch((error: unknown) => {
      console.error(`[Yjs] Mensagem inválida em ${shared.filePath}:`, error);

      closeConnection(connection, 1007, "Invalid Yjs payload");
    })
    .finally(() => {
      shared.pendingMessages -= 1;
    });
}

function scheduleDocumentCleanup(shared: SharedDocument): void {
  if (
    shared.connections.size > 0 ||
    shared.reservations > 0 ||
    shared.closingPromise
  ) {
    return;
  }

  shared.closingPromise = (async () => {
    await shared.messageQueue;

    if (shared.connections.size > 0 || shared.reservations > 0) {
      return;
    }

    await shared.ready;

    await persistence?.writeState(shared.docName, shared.doc);

    if (shared.connections.size > 0 || shared.reservations > 0) return;
    if (documents.get(shared.docName) !== shared) return;

    documents.delete(shared.docName);
    await persistence?.destroyState?.(shared.docName, shared.doc);

    shared.awareness.destroy();
    shared.doc.destroy();
  })()
    .catch((error: unknown) => {
      // Em caso de falha de persistência, mantém o Y.Doc na RAM. É melhor
      // reter a sala e aceitar uma nova conexão do que destruir estado ainda
      // não gravado.
      console.error(
        `[Yjs] Não foi possível finalizar a sala ${shared.filePath}:`,
        error,
      );
    })
    .finally(() => {
      shared.closingPromise = null;
    });
}

function releaseConnection(
  shared: SharedDocument,
  connection: WebSocket,
): void {
  const state = shared.connections.get(connection);
  if (!state || state.closed) return;

  state.closed = true;
  shared.connections.delete(connection);

  const ownedClientIds = Array.from(state.controlledAwarenessIds).filter(
    (clientId) => shared.awarenessOwners.get(clientId) === connection,
  );

  for (const clientId of ownedClientIds) {
    shared.awarenessOwners.delete(clientId);
  }

  state.controlledAwarenessIds.clear();

  if (ownedClientIds.length > 0) {
    awarenessProtocol.removeAwarenessStates(
      shared.awareness,
      ownedClientIds,
      connection,
    );
  }

  scheduleDocumentCleanup(shared);
}

function sendInitialSync(shared: SharedDocument, connection: WebSocket): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, shared.doc);
  const message = encoding.toUint8Array(encoder);
  send(connection, message);

  sendAwarenessSnapshot(shared, connection);
}

export async function setupWSConnection(
  connection: WebSocket,
  request: IncomingMessage,
  authenticatedUser: YjsAuthenticatedConnection,
): Promise<void> {
  let identity: { docName: string; filePath: string };

  try {
    identity = parseDocumentIdentity(request);
  } catch (error) {
    console.error("[Yjs] Sala recusada:", error);
    closeConnection(connection, 1008, "Invalid document path");
    return;
  }

  if (isPathDeleted(identity.filePath)) {
    closeConnection(connection, 1008, "Document deleted");
    return;
  }

  const shared = reserveSharedDocument(identity.docName, identity.filePath);
  if (!shared) {
    closeConnection(connection, 1013, "Room is restarting");
    return;
  }

  const authenticatedPresenceId = normalizePresenceIdentity(
    authenticatedUser.userEmail,
  );

  if (!authenticatedPresenceId) {
    closeConnection(connection, 1008, "Authenticated user has no email");
    return;
  }

  const connectionState: ConnectionState = {
    controlledAwarenessIds: new Set(),
    authenticatedPresenceId,
    userId: authenticatedUser.userId,
    userRole: authenticatedUser.userRole,
    canWriteGlobal: authenticatedUser.userRole === "admin",
    closed: false,
  };

  shared.connections.set(connection, connectionState);
  shared.reservations -= 1;
  connection.binaryType = "arraybuffer";

  connection.on("message", (rawData: RawData, isBinary: boolean) => {
    if (!isBinary) {
      closeConnection(connection, 1003, "Binary messages required");
      return;
    }

    const message = toUint8Array(rawData);
    enqueueIncomingMessage(shared, connection, connectionState, message);
  });

  connection.once("close", (code, reason) => {
    releaseConnection(shared, connection);
  });

  connection.once("error", (error: Error) => {
    console.error(`[Yjs] Erro na sala ${shared.filePath}:`, error);
  });

  try {
    await shared.ready;

    if (!connectionState.closed) {
      sendInitialSync(shared, connection);
    }
  } catch (error) {
    console.error(`[Yjs] Falha ao inicializar ${shared.filePath}:`, error);
    closeConnection(connection, 1011, "Document initialization failed");
  }
}

export function setPersistence(config: YjsPersistenceAdapter): void {
  persistence = config;
}
