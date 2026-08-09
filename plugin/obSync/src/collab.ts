import { type Extension } from '@codemirror/state';
import { yCollab } from 'y-codemirror.next';
import { WebsocketProvider, messageSync } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
	initializeOfflinePersistence,
	type OfflinePersistenceHandle,
} from './offlinePersistence.ts';

type CollaborationUser = {
	name: string;
	email: string;
	role: 'admin' | 'user';
};

type PresenceUser = {
	id: string;
	name: string;
	color: string;
	colorLight: string;
};

type RemotePresence = {
	id: string;
	name: string;
};

type AwarenessChange = {
	added: number[];
	updated: number[];
	removed: number[];
};

type ActiveRoom = {
	fileName: string;
	provider: WebsocketProvider;
	persistence: OfflinePersistenceHandle;
	ydoc: Y.Doc;
	remoteClients: Map<number, RemotePresence>;
	remoteUserClients: Map<string, Set<number>>;
	pendingLeaveTimers: Map<string, number>;
	onAwarenessChange: (change: AwarenessChange) => void;
	onBrowserOnline: () => void;
	onVisibilityChange: () => void;
	closing: boolean;
	persistenceReady: boolean;
	networkEnabled: boolean;
};

export type PreparedCollabRoom = {
	readonly extension: Extension;
	readonly initialText: string;
	/**
	 * Libera a conexão de rede somente depois que o main.ts montar o yCollab no
	 * editor. Dessa forma, o editor nunca observa um Y.Doc parcialmente
	 * restaurado do IndexedDB.
	 */
	connect(): void;
};

let activeRoom: ActiveRoom | null = null;

const MAX_RECONNECT_BACKOFF_MS = 30_000;
const PERIODIC_STATE_VECTOR_SYNC_MS = 5 * 60_000;
const PRESENCE_LEAVE_GRACE_MS = 1_000;
const INITIAL_NETWORK_SYNC_TIMEOUT_MS = 3_000;
const colors = ['#e74c3c', '#2ecc71', '#3498db', '#9b59b6', '#f39c12'];

function configureReadOnlyProvider(
	provider: WebsocketProvider,
	ydoc: Y.Doc,
): void {
	// Remove o observador padrão que transforma qualquer edição local em uma
	// mensagem Yjs Update enviada ao servidor. O IndexedDB continua observando
	// o mesmo Y.Doc, portanto a ramificação privada ainda é persistida localmente.
	ydoc.off('update', provider._updateHandler);

	provider.messageHandlers[messageSync] = (
		_encoder,
		decoder,
		currentProvider,
		emitSynced,
	): void => {
		const syncMessageType = decoding.readVarUint(decoder);

		switch (syncMessageType) {
			case syncProtocol.messageYjsSyncStep1:
				// O provider padrão responderia com Sync Step 2 contendo a diferença
				// local. Em modo leitura apenas consumimos o State Vector remoto.
				decoding.readVarUint8Array(decoder);
				return;

			case syncProtocol.messageYjsSyncStep2:
			case syncProtocol.messageYjsUpdate: {
				const update = decoding.readVarUint8Array(decoder);
				Y.applyUpdate(currentProvider.doc, update, currentProvider);

				if (
					emitSynced &&
					syncMessageType === syncProtocol.messageYjsSyncStep2 &&
					!currentProvider.synced
				) {
					currentProvider.synced = true;
				}
				return;
			}

			default:
				throw new Error(
					`Tipo de sincronização Yjs desconhecido: ${syncMessageType}`,
				);
		}
	};
}

function normalizePresenceId(value: string): string {
	return value.trim().toLowerCase();
}

function getUserColor(email: string): string {
	const index =
		[...email].reduce(
			(total, character) => total + character.charCodeAt(0),
			0,
		) % colors.length;
	return colors[index] ?? '#3498db';
}

function getPresenceUser(user: CollaborationUser): PresenceUser {
	const color = getUserColor(user.email);
	return {
		id: normalizePresenceId(user.email),
		name: user.name,
		color,
		colorLight: `${color}33`,
	};
}

function getRemotePresence(
	provider: WebsocketProvider,
	clientId: number,
): RemotePresence | null {
	const state = provider.awareness.getStates().get(clientId);
	const user = state?.user as Partial<PresenceUser> | undefined;

	if (
		typeof user?.id !== 'string' ||
		typeof user.name !== 'string' ||
		!user.id.trim() ||
		!user.name.trim()
	) {
		return null;
	}

	return {
		id: normalizePresenceId(user.id),
		name: user.name.trim(),
	};
}

function cancelPendingLeave(room: ActiveRoom, userId: string): boolean {
	const timer = room.pendingLeaveTimers.get(userId);
	if (timer === undefined) return false;

	window.clearTimeout(timer);
	room.pendingLeaveTimers.delete(userId);
	return true;
}

function scheduleUserLeft(
	room: ActiveRoom,
	presence: RemotePresence,
	onUserLeft: (name: string) => void,
): void {
	cancelPendingLeave(room, presence.id);

	const timer = window.setTimeout(() => {
		room.pendingLeaveTimers.delete(presence.id);

		if (activeRoom !== room || room.closing) return;

		const activeClientIds = room.remoteUserClients.get(presence.id);
		if (!activeClientIds || activeClientIds.size === 0) {
			onUserLeft(presence.name);
		}
	}, PRESENCE_LEAVE_GRACE_MS);

	room.pendingLeaveTimers.set(presence.id, timer);
}

function removeRemoteClient(
	room: ActiveRoom,
	clientId: number,
	onUserLeft: (name: string) => void,
): void {
	const presence = room.remoteClients.get(clientId);
	if (!presence) return;

	room.remoteClients.delete(clientId);

	const userClients = room.remoteUserClients.get(presence.id);
	userClients?.delete(clientId);

	// Outro clientId da mesma pessoa ainda está ativo. Isso pode acontecer por
	// alguns instantes durante uma reconexão ou troca rápida de provider.
	if (userClients && userClients.size > 0) return;

	room.remoteUserClients.delete(presence.id);
	scheduleUserLeft(room, presence, onUserLeft);
}

function addRemoteClient(
	room: ActiveRoom,
	clientId: number,
	presence: RemotePresence,
	onUserJoined: (name: string) => void,
	onUserLeft: (name: string) => void,
): void {
	const previousPresence = room.remoteClients.get(clientId);

	if (previousPresence?.id === presence.id) {
		room.remoteClients.set(clientId, presence);
		return;
	}

	if (previousPresence) {
		removeRemoteClient(room, clientId, onUserLeft);
	}

	let userClients = room.remoteUserClients.get(presence.id);
	const userWasAbsent = !userClients || userClients.size === 0;
	const wasReconnecting = cancelPendingLeave(room, presence.id);

	if (!userClients) {
		userClients = new Set<number>();
		room.remoteUserClients.set(presence.id, userClients);
	}

	room.remoteClients.set(clientId, presence);
	userClients.add(clientId);

	// Uma reconexão dentro da janela de tolerância não é uma nova entrada real.
	if (userWasAbsent && !wasReconnecting) {
		onUserJoined(presence.name);
	}
}

/**
 * O y-websocket executa novamente o Sync Step 1 em toda abertura de socket.
 * Esse passo carrega o State Vector do Y.Doc já restaurado do IndexedDB e faz
 * com que cliente e servidor troquem apenas os updates que ainda não possuem.
 */
function reconnectIfNecessary(room: ActiveRoom): void {
	if (
		activeRoom !== room ||
		room.closing ||
		!room.persistenceReady ||
		!room.networkEnabled ||
		room.provider.wsconnected ||
		room.provider.wsconnecting
	) {
		return;
	}

	room.provider.connect();
}

function waitForInitialNetworkSync(room: ActiveRoom): Promise<boolean> {
	if (room.provider.synced) return Promise.resolve(true);

	return new Promise((resolve) => {
		let finished = false;

		const finish = (synced: boolean): void => {
			if (finished) return;
			finished = true;
			window.clearTimeout(timeout);
			room.provider.off('sync', onSync);
			resolve(synced);
		};

		const onSync = (synced: boolean): void => {
			if (synced) finish(true);
		};

		const timeout = window.setTimeout(
			() => finish(false),
			INITIAL_NETWORK_SYNC_TIMEOUT_MS,
		);

		room.provider.on('sync', onSync);
		reconnectIfNecessary(room);
	});
}

/**
 * Prepara uma sala colaborativa sem montar imediatamente o binding do editor.
 *
 * A ordem é intencional:
 * 1. cria o Y.Doc;
 * 2. restaura integralmente os updates locais do IndexedDB;
 * 3. cria o yCollab sobre o estado restaurado;
 * 4. o main.ts monta a extensão;
 * 5. somente então `connect()` libera o WebSocket.
 *
 * Isso elimina a corrida em que o CodeMirror era ligado a um Y.Text vazio e,
 * alguns milissegundos depois, recebia a versão antiga restaurada do IndexedDB.
 */
export async function setupCollabRoom(
	fileName: string,
	initialEditorText: string,
	user: CollaborationUser,
	token: string,
	onUserJoined: (name: string) => void,
	onUserLeft: (name: string) => void,
): Promise<PreparedCollabRoom | null> {
	closeCollabRoom();

	const ydoc = new Y.Doc();
	const ytext = ydoc.getText('codemirror');
	const roomName = encodeURIComponent(fileName);
	const persistence = initializeOfflinePersistence({
		documentId: fileName,
		ydoc,
	});

	const provider = new WebsocketProvider(
		'ws://localhost:3000',
		roomName,
		ydoc,
		{
			connect: false,
			params: { token },
			maxBackoffTime: MAX_RECONNECT_BACKOFF_MS,
			resyncInterval: PERIODIC_STATE_VECTOR_SYNC_MS,
			disableBc: true,
		},
	);

	if (user.role === 'user') {
		configureReadOnlyProvider(provider, ydoc);
	}

	const room: ActiveRoom = {
		fileName,
		provider,
		persistence,
		ydoc,
		remoteClients: new Map<number, RemotePresence>(),
		remoteUserClients: new Map<string, Set<number>>(),
		pendingLeaveTimers: new Map<string, number>(),
		onAwarenessChange: () => undefined,
		onBrowserOnline: () => undefined,
		onVisibilityChange: () => undefined,
		closing: false,
		persistenceReady: false,
		networkEnabled: false,
	};

	room.onAwarenessChange = ({ added, updated, removed }) => {
		if (activeRoom !== room || room.closing) return;

		const changedClientIds = new Set<number>([...added, ...updated]);
		for (const clientId of changedClientIds) {
			if (clientId === ydoc.clientID) continue;

			const presence = getRemotePresence(provider, clientId);
			if (!presence) continue;

			addRemoteClient(room, clientId, presence, onUserJoined, onUserLeft);
		}

		for (const clientId of new Set<number>(removed)) {
			if (clientId === ydoc.clientID) continue;
			removeRemoteClient(room, clientId, onUserLeft);
		}
	};

	room.onBrowserOnline = () => reconnectIfNecessary(room);
	room.onVisibilityChange = () => {
		if (document.visibilityState === 'visible') {
			reconnectIfNecessary(room);
		}
	};

	activeRoom = room;
	provider.awareness.on('change', room.onAwarenessChange);
	provider.awareness.setLocalStateField('user', getPresenceUser(user));
	window.addEventListener('online', room.onBrowserOnline);
	document.addEventListener('visibilitychange', room.onVisibilityChange);

	try {
		await persistence.ready;
	} catch (error) {
		if (activeRoom === room) closeCollabRoom();
		throw error;
	}

	// A nota pode ter sido trocada enquanto o IndexedDB ainda carregava.
	if (activeRoom !== room || room.closing) return null;

	room.persistenceReady = true;

	// Em uma nota sem estado local, fazemos uma sincronização inicial curta
	// antes de montar o CodeMirror. Isso evita ligar um editor preenchido a um
	// Y.Text vazio e depois aplicar o estado remoto como inserção duplicada.
	if (ytext.length === 0) {
		room.networkEnabled = true;
		await waitForInitialNetworkSync(room);

		// Congela o Y.Doc durante a montagem do editor. O connect() fará uma nova
		// troca de State Vectors imediatamente depois da extensão ser instalada.
		provider.disconnect();
		room.networkEnabled = false;

		if (activeRoom !== room || room.closing) return null;

		// Se servidor e IndexedDB também estavam vazios, a nota local é o estado
		// inicial legítimo. A partir daqui ela já possui identidade CRDT.
		if (ytext.length === 0 && initialEditorText.length > 0) {
			ydoc.transact(() => {
				ytext.insert(0, initialEditorText);
			}, 'initial-markdown-bootstrap');
		}
	}

	const initialText = ytext.toJSON();
	const extension = yCollab(ytext, provider.awareness);

	return {
		extension,
		initialText,
		connect(): void {
			if (activeRoom !== room || room.closing) return;
			room.networkEnabled = true;
			reconnectIfNecessary(room);
		},
	};
}

export function closeCollabRoom(): void {
	const room = activeRoom;
	if (!room) return;

	activeRoom = null;
	room.closing = true;
	room.networkEnabled = false;
	window.removeEventListener('online', room.onBrowserOnline);
	document.removeEventListener('visibilitychange', room.onVisibilityChange);

	for (const timer of room.pendingLeaveTimers.values()) {
		window.clearTimeout(timer);
	}

	room.pendingLeaveTimers.clear();
	room.remoteClients.clear();
	room.remoteUserClients.clear();

	room.provider.awareness.setLocalState(null);
	room.provider.awareness.off('change', room.onAwarenessChange);
	room.provider.destroy();

	// O banco não é apagado. Apenas a conexão desta instância é encerrada para
	// que a próxima abertura da nota recupere a mesma história CRDT.
	void room.persistence.destroy().finally(() => room.ydoc.destroy());
}

export function getCurrentCollabRoomPath(): string | null {
	return activeRoom?.fileName ?? null;
}
