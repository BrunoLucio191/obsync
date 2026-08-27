import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { t } from '../i18n/i18n.ts';

/** Namespace used for offline persistence when the caller doesn't specify one. */
export const DEFAULT_OFFLINE_NAMESPACE = 'your-mon';

/** Options for opening offline (IndexedDB) persistence for a Yjs document. */
export type OfflinePersistenceOptions = {
	/** Stable identifier for the document (typically its vault path). */
	documentId: string;
	/** The Yjs document to persist/load updates into. */
	ydoc: Y.Doc;
	/** Isolates documents into separate IndexedDB databases per user/scope; defaults to {@link DEFAULT_OFFLINE_NAMESPACE}. */
	namespace?: string;
};

/** Handle returned by {@link initializeOfflinePersistence} for managing a document's offline storage. */
export type OfflinePersistenceHandle = {
	readonly databaseName: string;
	readonly provider: IndexeddbPersistence;
	/** Resolves once the document has finished loading from IndexedDB. */
	readonly ready: Promise<void>;
	/** Closes the IndexedDB connection without deleting stored data. */
	destroy(): Promise<void>;
	/** Deletes all persisted data for this document from IndexedDB. */
	clear(): Promise<void>;
};

/** Tracks the persistence handle already open for a given Yjs document, to avoid opening it twice. */
const activePersistence = new WeakMap<Y.Doc, OfflinePersistenceHandle>();

/**
 * Builds the IndexedDB database name for a document, scoped by namespace.
 * @param documentId - Stable identifier for the document.
 * @param namespace - Namespace to scope the database under.
 * @returns The composed database name.
 * @throws If `documentId` or `namespace` is empty after trimming.
 */
function buildDatabaseName(documentId: string, namespace: string): string {
	const normalizedDocumentId = documentId.trim();
	const normalizedNamespace = namespace.trim();

	if (!normalizedDocumentId) {
		throw new Error(t('offlinePersistence.emptyDocumentId'));
	}

	if (!normalizedNamespace) {
		throw new Error(t('offlinePersistence.emptyNamespace'));
	}
	return `${normalizedNamespace}:${encodeURIComponent(normalizedDocumentId)}`;
}

/**
 * Opens (or reuses) offline persistence for a Yjs document, backing it with an
 * IndexedDB database so local edits and CRDT history survive across sessions
 * and offline periods. Returns the existing handle if this document already
 * has persistence initialized.
 * @param options - Document, namespace, and identifier to persist under.
 * @returns A handle for awaiting readiness and later destroying/clearing storage.
 * @throws If IndexedDB is unavailable in the current environment, or if the
 * resulting database name would be empty.
 */
export function initializeOfflinePersistence(
	options: OfflinePersistenceOptions,
): OfflinePersistenceHandle {
	const {
		documentId,
		ydoc,
		namespace = DEFAULT_OFFLINE_NAMESPACE,
	} = options;

	if (typeof indexedDB === 'undefined') {
		throw new Error(t('offlinePersistence.indexedDbUnavailable'));
	}

	const existingHandle = activePersistence.get(ydoc);
	if (existingHandle) return existingHandle;

	const databaseName = buildDatabaseName(documentId, namespace);
	const provider = new IndexeddbPersistence(databaseName, ydoc);
	const ready = provider.whenSynced.then(() => undefined);
	let destroyed = false;

	const handle: OfflinePersistenceHandle = {
		databaseName,
		provider,
		ready,

		async destroy(): Promise<void> {
			if (destroyed) return;

			destroyed = true;
			activePersistence.delete(ydoc);
			await provider.destroy();
		},

		async clear(): Promise<void> {
			activePersistence.delete(ydoc);
			destroyed = true;
			await provider.clearData();
		},
	};
	ydoc.once('destroy', () => {
		destroyed = true;
		activePersistence.delete(ydoc);
	});

	return handle;
}
