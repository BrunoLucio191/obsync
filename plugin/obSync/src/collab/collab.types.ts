import { WebsocketProvider } from 'y-websocket';
import type { OfflinePersistenceHandle } from './OfflinePersistence.ts';
import * as Y from 'yjs';
import { Extension } from '@codemirror/state';

export type CollaborationUser = {
	name: string;
	email: string;
	role: 'admin' | 'user';
};

export type PresenceUser = {
	id: string;
	name: string;
	color: string;
	colorLight: string;
};

export type RemotePresence = {
	id: string;
	name: string;
};

export type AwarenessChange = {
	added: number[];
	updated: number[];
	removed: number[];
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
	closing: boolean;
	persistenceReady: boolean;
	networkEnabled: boolean;
};

export type PreparedCollabRoom = {
	readonly extension: Extension;
	readonly initialText: string;

	connect(): void;
};
