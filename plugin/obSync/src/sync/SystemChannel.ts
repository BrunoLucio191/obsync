import { API_BASE_URL } from '../config/ApiConfig.ts';
import type { AuthService } from '../auth/AuthService.ts';
import type { RemoteVaultChangeService } from '../vault/RemoteVaultChangeService.ts';
import type { VaultChange } from '../vault/VaultChange.ts';

export class SystemChannel {
	private socket: WebSocket | null = null;

	public constructor(
		private readonly auth: AuthService,
		private readonly remoteChanges: RemoteVaultChangeService,
	) {}

	public connect(): void {
		this.disconnect();

		const url = new URL(`${API_BASE_URL.replace(/^http/, 'ws')}/system`);
		url.searchParams.set('token', this.auth.token);
		const socket = new WebSocket(url.toString());
		this.socket = socket;

		socket.onmessage = (event) => {
			try {
				const change = JSON.parse(event.data as string) as VaultChange;
				if (change.originClientId !== this.auth.clientId) {
					void this.remoteChanges.apply(change);
				}
			} catch (error) {
				console.error('Evento de sincronização inválido:', error);
			}
		};

		socket.onclose = (event) => {
			if (this.socket !== socket) return;
			this.socket = null;
			if (event.code === 4003 && this.auth.token) {
				this.auth.scheduleSessionRefresh();
			}
		};
	}

	public disconnect(): void {
		const socket = this.socket;
		this.socket = null;
		if (socket) socket.close();
	}
}
