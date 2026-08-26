import {
	getWebSocketBaseUrl,
	webSocketTicketProtocol,
} from '../config/ApiConfig.ts';
import { t } from '../i18n/i18n.ts';
import type { AuthService } from '../auth/AuthService.ts';
import type { RemoteVaultChangeService } from '../vault/RemoteVaultChangeService.ts';
import type { VaultChange } from '../vault/VaultChange.ts';

const RECONNECT_DELAY_MS = 1_000;

export class SystemChannel {
	private socket: WebSocket | null = null;
	private reconnectTimer: number | null = null;
	private generation = 0;

	public constructor(
		private readonly auth: AuthService,
		private readonly remoteChanges: RemoteVaultChangeService,
	) {}

	public connect(): void {
		this.closeCurrentConnection();
		const generation = ++this.generation;
		void this.openWithTicket(generation);
	}

	public disconnect(): void {
		this.generation += 1;
		this.closeCurrentConnection();
	}

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
