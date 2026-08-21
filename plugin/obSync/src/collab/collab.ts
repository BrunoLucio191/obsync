import { yCollab } from 'y-codemirror.next';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { ActiveRoom } from './collab.types.ts';
import {
	initializeOfflinePersistence,
} from './OfflinePersistence.ts';
import { CollaborationUser } from './collab.types.ts';
import { RemotePresence } from './collab.types.ts';
import { PresenceUser } from './collab.types.ts';
import { normalizePresenceId, getPresenceUser } from './collab.utils.ts';
import { PreparedCollabRoom } from './collab.types.ts';
import {
	PRESENCE_LEAVE_GRACE_MS,
	MAX_RECONNECT_BACKOFF_MS,
	PERIODIC_STATE_VECTOR_SYNC_MS,
	OFFLINE_NAMESPACE_VERSION,
} from './collab.cons.ts';
import {
	WEB_SOCKET_BASE_URL,
	webSocketTicketProtocol,
} from '../config/ApiConfig.ts';

let activeRoom: ActiveRoom | null = null;

function getOfflineNamespace(user: CollaborationUser): string {
	if (user.role === 'admin') return `${OFFLINE_NAMESPACE_VERSION}:global`;

	const identity = encodeURIComponent(user.email.trim().toLowerCase());
	return `${OFFLINE_NAMESPACE_VERSION}:private:${identity}`;
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

	if (userWasAbsent && !wasReconnecting) {
		onUserJoined(presence.name);
	}
}

async function reconnectWithFreshTicket(room: ActiveRoom): Promise<void> {
	if (
		activeRoom !== room ||
		room.closing ||
		!room.persistenceReady ||
		!room.networkEnabled ||
		room.provider.wsconnected ||
		room.provider.wsconnecting ||
		room.ticketRequestInFlight
	) {
		return;
	}

	room.ticketRequestInFlight = true;
	try {
		const ticket = await room.requestWebSocketTicket();
		if (
			!ticket ||
			activeRoom !== room ||
			room.closing ||
			!room.networkEnabled
		) {
			if (!ticket) scheduleTicketReconnect(room);
			return;
		}

		room.provider.protocols = [webSocketTicketProtocol(ticket)];
		room.provider.connect();
	} finally {
		room.ticketRequestInFlight = false;
	}
}

function scheduleTicketReconnect(room: ActiveRoom): void {
	if (
		activeRoom !== room ||
		room.closing ||
		!room.networkEnabled ||
		room.ticketReconnectTimer !== null
	) {
		return;
	}

	room.ticketReconnectTimer = window.setTimeout(() => {
		room.ticketReconnectTimer = null;
		void reconnectWithFreshTicket(room);
	}, 1_000);
}

export async function setupCollabRoom(
	fileName: string,
	user: CollaborationUser,
	requestWebSocketTicket: () => Promise<string | null>,
	onUserJoined: (name: string) => void,
	onUserLeft: (name: string) => void,
): Promise<PreparedCollabRoom | null> {
	closeCollabRoom();

	const ydoc = new Y.Doc();
	const ytext = ydoc.getText('codemirror');
	// private doc for user
	const networkDoc = user.role === 'user' ? new Y.Doc() : ydoc;
	const roomName = encodeURIComponent(fileName);
	const persistence = initializeOfflinePersistence({
		documentId: fileName,
		ydoc,
		namespace: getOfflineNamespace(user),
	});

	const provider = new WebsocketProvider(
		WEB_SOCKET_BASE_URL,
		roomName,
		networkDoc,
		{
			connect: false,
			protocols: [],
			maxBackoffTime: MAX_RECONNECT_BACKOFF_MS,
			resyncInterval: PERIODIC_STATE_VECTOR_SYNC_MS,
			disableBc: true,
		},
	);

	const onNetworkUpdate =
		user.role === 'user'
			? (update: Uint8Array): void => {
					Y.applyUpdate(ydoc, update, provider);
				}
			: null;
	if (onNetworkUpdate) networkDoc.on('update', onNetworkUpdate);

	const room: ActiveRoom = {
		fileName,
		provider,
		persistence,
		ydoc,
		networkDoc,
		onNetworkUpdate,
		remoteClients: new Map<number, RemotePresence>(),
		remoteUserClients: new Map<string, Set<number>>(),
		pendingLeaveTimers: new Map<string, number>(),
		onAwarenessChange: () => undefined,
		onBrowserOnline: () => undefined,
		onVisibilityChange: () => undefined,
		onConnectionClose: () => undefined,
		requestWebSocketTicket,
		ticketReconnectTimer: null,
		ticketRequestInFlight: false,
		closing: false,
		persistenceReady: false,
		networkEnabled: false,
	};

	room.onAwarenessChange = ({ added, updated, removed }) => {
		if (activeRoom !== room || room.closing) return;

		const changedClientIds = new Set<number>([...added, ...updated]);
		for (const clientId of changedClientIds) {
			if (clientId === provider.awareness.clientID) continue;

			const presence = getRemotePresence(provider, clientId);
			if (!presence) continue;

			addRemoteClient(room, clientId, presence, onUserJoined, onUserLeft);
		}

		for (const clientId of new Set<number>(removed)) {
			if (clientId === provider.awareness.clientID) continue;
			removeRemoteClient(room, clientId, onUserLeft);
		}
	};

	room.onBrowserOnline = () => void reconnectWithFreshTicket(room);
	room.onVisibilityChange = () => {
		if (document.visibilityState === 'visible') {
			void reconnectWithFreshTicket(room);
		}
	};
	room.onConnectionClose = () => {
		if (activeRoom !== room || room.closing || !room.networkEnabled) return;
		room.provider.shouldConnect = false;
		window.setTimeout(() => {
			void reconnectWithFreshTicket(room);
		}, 0);
	};

	activeRoom = room;
	provider.awareness.on('change', room.onAwarenessChange);
	provider.on('connection-close', room.onConnectionClose);
	provider.awareness.setLocalStateField('user', getPresenceUser(user));
	window.addEventListener('online', room.onBrowserOnline);
	document.addEventListener('visibilitychange', room.onVisibilityChange);

	try {
		await persistence.ready;
	} catch (error) {
		if (activeRoom === room) closeCollabRoom();
		throw error;
	}

	room.persistenceReady = true;

	const initialText = ytext.toJSON();
	const extension = yCollab(ytext, provider.awareness);

	return {
		extension,
		initialText,
		connect(): void {
			if (activeRoom !== room || room.closing) return;
			room.networkEnabled = true;
			void reconnectWithFreshTicket(room);
		},
	};
}

export function closeCollabRoom(): void {
	const room = activeRoom;
	if (!room) return;

	activeRoom = null;
	room.closing = true;
	room.networkEnabled = false;
	if (room.ticketReconnectTimer !== null) {
		window.clearTimeout(room.ticketReconnectTimer);
		room.ticketReconnectTimer = null;
	}
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
	room.provider.off('connection-close', room.onConnectionClose);
	room.provider.destroy();
	if (room.onNetworkUpdate) {
		room.networkDoc.off('update', room.onNetworkUpdate);
		room.networkDoc.destroy();
	}

	// O banco não é apagado. Apenas a conexão desta instância é encerrada para
	// que a próxima abertura da nota recupere a mesma história CRDT.
	void room.persistence.destroy().finally(() => room.ydoc.destroy());
}

export function getCurrentCollabRoomPath(): string | null {
	return activeRoom?.fileName ?? null;
}
