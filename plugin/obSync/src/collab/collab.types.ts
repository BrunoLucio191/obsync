import { WebsocketProvider } from 'y-websocket';
import type { OfflinePersistenceHandle } from './OfflinePersistence.ts';
import * as Y from 'yjs';
import { Extension } from '@codemirror/state';

/** Identity of the local user driving a collaboration session. */
export type CollaborationUser = {
	name: string;
	email: string;
	role: 'admin' | 'user';
};

/** Presence payload broadcast through Yjs awareness so peers can render this user's cursor/name/color. */
export type PresenceUser = {
	id: string;
	name: string;
	color: string;
	colorLight: string;
};

/** Normalized identity of a remote collaborator, derived from their awareness state. */
export type RemotePresence = {
	id: string;
	name: string;
};

/** Set of awareness client IDs that were added, updated, or removed in a single awareness `change` event. */
export type AwarenessChange = {
	added: number[];
	updated: number[];
	removed: number[];
};

/**
 * Full runtime state for a single open collaboration room (one file being edited live).
 * Tracks the Yjs docs, the websocket provider, offline persistence, connected remote
 * clients, and the event handlers/timers needed to manage reconnects and presence.
 */

export type Backoff = {
	next: () => number;
	reset: () => void;
};

export type ActiveRoom = {
	fileName: string;
	provider: WebsocketProvider;
	persistence: OfflinePersistenceHandle;
	ydoc: Y.Doc;
	networkDoc: Y.Doc;
	onNetworkUpdate: ((update: Uint8Array) => void) | null;
	remoteClients: Map<number, RemotePresence>;
	remoteUserClients: Map<string, Set<number>>;
	pendingLeaveTimers: Map<string, number>;
	onAwarenessChange: (change: AwarenessChange) => void;
	onBrowserOnline: () => void;
	onVisibilityChange: () => void;
	onConnectionClose: () => void;
	requestWebSocketTicket: () => Promise<string | null>;
	ticketReconnectTimer: number | null;
	ticketRequestInFlight: boolean;
	closing: boolean;
	persistenceReady: boolean;
	networkEnabled: boolean;
	reconnectDelayMs: Backoff;
};

/** Result of {@link setupCollabRoom}, handed to the editor once offline persistence has loaded. */
export type PreparedCollabRoom = {
	/** CodeMirror extension wiring the shared text and awareness into the editor. */
	readonly extension: Extension;
	/** Document text as restored from local (offline) storage, before the network connects. */
	readonly initialText: string;

	/** Enables the network connection for this room (call once the editor view is confirmed active). */
	connect(): void;
};
