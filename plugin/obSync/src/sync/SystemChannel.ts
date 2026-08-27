import {
	getWebSocketBaseUrl,
	webSocketTicketProtocol,
} from '../config/ApiConfig.ts';
import { t } from '../i18n/i18n.ts';
import type { AuthService } from '../auth/AuthService.ts';
import type { RemoteVaultChangeService } from '../vault/RemoteVaultChangeService.ts';
import type { VaultChange } from '../vault/VaultChange.ts';

/** Delay (ms) before retrying a dropped or failed system-channel connection. */
const RECONNECT_DELAY_MS = 1_000;

/**
 * Maintains a persistent websocket to the backend's `/system` channel, which
 * broadcasts vault changes (create/delete/modify/rename) made by other
 * clients. Reconnects automatically on disconnect or auth expiry, using a
 * generation counter to discard stale reconnect attempts after `disconnect()`.
 */
export class SystemChannel {
	private socket: WebSocket | null = null;
	private reconnectTimer: number | null = null;
	/** Incremented on every connect/disconnect to invalidate callbacks from a superseded connection attempt. */
	private generation = 0;

	public constructor(
		private readonly auth: AuthService,
		private readonly remoteChanges: RemoteVaultChangeService,
	) {}

	/** Closes any existing connection and opens a new system-channel websocket. */
	public connect(): void {
		this.closeCurrentConnection();
		const generation = ++this.generation;
		void this.openWithTicket(generation);
	}

	/** Closes the connection and stops any scheduled reconnect attempts. */
	public disconnect(): void {
		this.generation += 1;
		this.closeCurrentConnection();
	}

	/**
	 * Obtains an auth ticket and opens the websocket, wiring up message and
	 * close handlers. No-ops if a newer `connect`/`disconnect` call has
	 * superseded this attempt's generation.
	 * @param generation - The generation this connection attempt belongs to.
	 */
	private async openWithTicket(generation: number): Promise<void> {
		const ticket = await this.auth.createWebSocketTicket('system');
		if (generation !== this.generation) return;
		if (!ticket) {
			this.scheduleReconnect(generation);
			return;
		}

		const socket = new WebSocket(`${getWebSocketBaseUrl()}/system`, [
			webSocketTicketProtocol(ticket),
		]);
		this.socket = socket;

		socket.onmessage = (event) => {
			try {
				const change = JSON.parse(event.data as string) as VaultChange;
				if (change.originClientId !== this.auth.clientId) {
					void this.remoteChanges.apply(change);
				}
			} catch (error) {
				console.error(t('sync.invalidSyncEvent'), error);
			}
		};

		socket.onclose = (event) => {
			if (this.socket !== socket || generation !== this.generation) return;
			this.socket = null;
			if (event.code === 4003) {
				void this.auth.refreshSession().finally(() => {
					this.scheduleReconnect(generation);
				});
				return;
			}
			this.scheduleReconnect(generation);
		};
	}

	/**
	 * Schedules a single reconnect attempt after {@link RECONNECT_DELAY_MS},
	 * unless one is already pending, the session is no longer authenticated,
	 * or this generation has been superseded.
	 * @param generation - The generation to reconnect under.
	 */
	private scheduleReconnect(generation: number): void {
		if (
			generation !== this.generation ||
			!this.auth.isAuthenticated() ||
			this.reconnectTimer !== null
		) {
			return;
		}

		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			if (generation === this.generation) {
				void this.openWithTicket(generation);
			}
		}, RECONNECT_DELAY_MS);
	}

	/** Cancels any pending reconnect timer and closes the active socket, if any. */
	private closeCurrentConnection(): void {
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const socket = this.socket;
		this.socket = null;
		if (socket) socket.close();
	}
}
