import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';

const DEFAULT_NAMESPACE = 'obisync-crdt-v2';

export interface OfflinePersistenceOptions {
	documentId: string;
	ydoc: Y.Doc;
	namespace?: string;
}

export interface OfflinePersistenceHandle {
	readonly databaseName: string;
	readonly provider: IndexeddbPersistence;
	readonly ready: Promise<void>;
	destroy(): Promise<void>;
	clear(): Promise<void>;
}

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

/**
 * Vincula um Y.Doc ao IndexedDB do Obsidian/Electron.
 *
 * As atualizações do documento passam a ser persistidas automaticamente e são
 * recuperadas na próxima abertura, mesmo que o Obsidian tenha sido fechado
 * enquanto o servidor WebSocket estava indisponível.
 *
 * Inicialize este provider antes de criar o binding do editor e aguarde
 * `handle.ready` antes de considerar o estado local completamente carregado.
 */
export function initializeOfflinePersistence(
	options: OfflinePersistenceOptions,
): OfflinePersistenceHandle {
	const { documentId, ydoc, namespace = DEFAULT_NAMESPACE } = options;

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

	activePersistence.set(ydoc, handle);

	ydoc.once('destroy', () => {
		destroyed = true;
		activePersistence.delete(ydoc);
	});

	return handle;
}
