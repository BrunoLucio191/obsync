import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

export const DEFAULT_OFFLINE_NAMESPACE = 'your-mon';

export type OfflinePersistenceOptions = {
	documentId: string;
	ydoc: Y.Doc;
	namespace?: string;
};

export type OfflinePersistenceHandle = {
	readonly databaseName: string;
	readonly provider: IndexeddbPersistence;
	readonly ready: Promise<void>;
	destroy(): Promise<void>;
	clear(): Promise<void>;
};

const activePersistence = new WeakMap<Y.Doc, OfflinePersistenceHandle>();

function buildDatabaseName(documentId: string, namespace: string): string {
	const normalizedDocumentId = documentId.trim();
	const normalizedNamespace = namespace.trim();

	if (!normalizedDocumentId) {
		throw new Error('documentId não pode ser vazio.');
	}

	if (!normalizedNamespace) {
		throw new Error('namespace não pode ser vazio.');
	}
	return `${normalizedNamespace}:${encodeURIComponent(normalizedDocumentId)}`;
}

export function initializeOfflinePersistence(
	options: OfflinePersistenceOptions,
): OfflinePersistenceHandle {
	const {
		documentId,
		ydoc,
		namespace = DEFAULT_OFFLINE_NAMESPACE,
	} = options;

	if (typeof indexedDB === 'undefined') {
		throw new Error('IndexedDB não está disponível neste ambiente.');
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
