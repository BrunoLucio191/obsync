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
	getWebSocketBaseUrl,
	webSocketTicketProtocol,
} from '../config/ApiConfig.ts';

/** The single collaboration room currently open, or `null` if none is active. Only one room can be open at a time. */
let activeRoom: ActiveRoom | null = null;

/**
 * Computes the IndexedDB namespace used for offline persistence of a user's documents.
 * Admins share one global namespace (their edits apply to the shared vault); regular
 * users get a private namespace keyed by their own identity, so their offline copies
 * of read-only documents don't leak into or collide with anyone else's.
 * @param user - The collaboration user whose namespace is being computed.
 * @returns The offline persistence namespace string.
 */
function getOfflineNamespace(user: CollaborationUser): string {
	if (user.role === 'admin') return `${OFFLINE_NAMESPACE_VERSION}:global`;

	const identity = encodeURIComponent(user.email.trim().toLowerCase());
	return `${OFFLINE_NAMESPACE_VERSION}:private:${identity}`;
}

/**
 * Reads and validates the presence info a remote awareness client has published.
 * @param provider - The websocket provider whose awareness states are inspected.
 * @param clientId - The awareness client ID to look up.
 * @returns The remote user's normalized presence, or `null` if the client has no
 * (or malformed) presence data.
 */
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

/**
 * Cancels a pending "user left" timer for a given user, if one is scheduled.
 * @param room - The room whose pending-leave timers are checked.
 * @param userId - Normalized ID of the user whose leave timer should be cancelled.
 * @returns `true` if a pending timer was found and cancelled, `false` otherwise.
 */
function cancelPendingLeave(room: ActiveRoom, userId: string): boolean {
	const timer = room.pendingLeaveTimers.get(userId);
	if (timer === undefined) return false;

	window.clearTimeout(timer);
	room.pendingLeaveTimers.delete(userId);
	return true;
}

/**
 * Schedules a delayed "user left" notification for a presence, after cancelling
 * any previous pending leave for the same user. The delay ({@link PRESENCE_LEAVE_GRACE_MS})
 * absorbs the brief window where a user's awareness client flickers during a
 * reconnect, so they aren't announced as leaving and rejoining.
 * @param room - The room the presence belongs to.
 * @param presence - The remote user who may have left.
 * @param onUserLeft - Callback invoked with the user's name if they are confirmed gone.
 */
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

/**
 * Removes a disconnected awareness client from a room's tracking maps, and, if
 * it was the user's last active client, schedules a "user left" notification.
 * @param room - The room to update.
 * @param clientId - The awareness client ID that disconnected.
 * @param onUserLeft - Callback eventually invoked if the user has no clients left.
 */
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

	// Another clientId for the same person is still active. This can happen
	// for a few moments during a reconnection or a quick provider swap.
	if (userClients && userClients.size > 0) return;

	room.remoteUserClients.delete(presence.id);
	scheduleUserLeft(room, presence, onUserLeft);
}

/**
 * Registers (or updates) an awareness client as belonging to a remote user, and
 * fires the "user joined" callback the first time that user becomes present.
 * @param room - The room to update.
 * @param clientId - The awareness client ID that changed.
 * @param presence - The remote user's presence info for this client.
 * @param onUserJoined - Callback invoked with the user's name the first time they join.
 * @param onUserLeft - Callback passed through in case the client previously belonged to a different user.
 */
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

/**
 * Requests a fresh authentication ticket and (re)connects the room's websocket
 * provider with it. Guards against reconnecting a stale/closing/already-connecting
 * room, and against overlapping ticket requests.
 * @param room - The room to reconnect.
 */
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

/**
 * Schedules a single retry of {@link reconnectWithFreshTicket} after a short
 * delay, used when a ticket could not be obtained (e.g. session expired).
 * @param room - The room to retry connecting for.
 */
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

/**
 * Opens a new collaboration room for a file, closing any previously active room
 * first (only one room may be open at a time). Sets up the Yjs document(s),
 * offline (IndexedDB) persistence, the websocket provider, and awareness
 * listeners for remote presence, but does not connect to the network yet —
 * call {@link PreparedCollabRoom.connect} once the caller has confirmed the
 * editor view is still showing this file.
 *
 * For non-admin users, edits are made on a private in-memory doc and only
 * applied to the shared doc via incoming network updates, so their local doc
 * never leaks writes upstream (read-only collaboration).
 * @param fileName - Vault-relative path of the file to open a room for; also used as the room name.
 * @param user - The local user opening the room.
 * @param requestWebSocketTicket - Callback that obtains a fresh auth ticket for the websocket handshake.
 * @param onUserJoined - Callback invoked with a user's name when they join the room.
 * @param onUserLeft - Callback invoked with a user's name when they leave the room.
 * @returns The prepared room (editor extension + initial text + `connect()`), or `null` if setup failed.
 */
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
		getWebSocketBaseUrl(),
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

/**
 * Tears down the currently active collaboration room, if any: cancels timers,
 * removes DOM/awareness listeners, destroys the websocket provider and network
 * doc, and clears local presence. The offline (IndexedDB) database itself is
 * left intact so history is available the next time the same document is opened.
 */
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

	// The database is not deleted. Only this instance's connection is closed,
	// so the next time the note is opened it recovers the same CRDT history.
	void room.persistence.destroy().finally(() => room.ydoc.destroy());
}

/**
 * Returns the vault-relative path of the file whose collaboration room is
 * currently open.
 * @returns The active room's file path, or `null` if no room is open.
 */
export function getCurrentCollabRoomPath(): string | null {
	return activeRoom?.fileName ?? null;
}
