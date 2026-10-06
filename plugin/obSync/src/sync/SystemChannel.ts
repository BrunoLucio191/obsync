import {
	getWebSocketBaseUrl,
	webSocketTicketProtocol,
} from '../config/ApiConfig.ts';
import { t } from '../i18n/i18n.ts';
import type { AuthService } from '../auth/AuthService.ts';
import type { RemoteVaultChangeService } from '../vault/RemoteVaultChangeService.ts';
import type { VaultChange } from '../vault/VaultChange.ts';
import { ResyncWarning } from './ReSyncWarning.ts';
import { App } from 'obsidian';
import { SyncInitialVault } from './SyncInitialVault.ts';
type backOff = {
	next: () => number;
	reset: () => void;
};

/** Websocket to `/system`, where the backend broadcasts vault changes made by other clients. */
export class SystemChannel {
	#socket: WebSocket | null = null;
	#reconnectTimer: number | null = null;
	#operationGeneration: number = 0;
	#reconnectDelayMs = this.#creatBackoff();
	#disconnected = false;
	readonly #app: App;
	readonly #auth: AuthService;
	readonly #remoteChanges: RemoteVaultChangeService;
	readonly #initialVaultSync: SyncInitialVault;

	public constructor(
		auth: AuthService,
		remoteChanges: RemoteVaultChangeService,
		app: App,
		initialVaultSync: SyncInitialVault,
	) {
		this.#auth = auth;
		this.#remoteChanges = remoteChanges;
		this.#app = app;
		this.#initialVaultSync = initialVaultSync;
	}

	public connect(): void {
		this.#closeCurrentConnection();
		const generation = ++this.#operationGeneration;
		void this.#openWithTicket(generation);
	}

	public disconnect(): void {
		this.#operationGeneration += 1;
		this.#closeCurrentConnection();
	}

	async #openWithTicket(generation: number): Promise<void> {
		const ticket = await this.#auth.createWebSocketTicket('system');
		if (generation !== this.#operationGeneration) return;
		if (!ticket) {
			this.#scheduleReconnect(generation);
			return;
		}

		const socket = new WebSocket(`${getWebSocketBaseUrl()}/system`, [
			webSocketTicketProtocol(ticket),
		]);
		this.#socket = socket;

		socket.onopen = () => {
			this.#reconnectDelayMs.reset();
			if (this.#disconnected) {
				new ResyncWarning(this.#app, () =>
					this.#initialVaultSync.sync(),
				).open();
				this.#disconnected = false;
			}
		};
		socket.onmessage = (event) => {
			try {
				const change = JSON.parse(event.data as string) as VaultChange;

				if (change.originClientId !== this.#auth.clientId) {
					void this.#remoteChanges.apply(change);
				}
			} catch (error) {
				console.error(t('sync.invalidSyncEvent'), error);
			}
		};

		socket.onclose = (event) => {
			if (
				this.#socket !== socket ||
				generation !== this.#operationGeneration
			) {
				return;
			}
			this.#disconnected = true;
			this.#socket = null;
			if (event.code === 4003) {
				void this.#auth.refreshSession().finally(() => {
					this.#scheduleReconnect(generation);
				});
				return;
			}
			this.#scheduleReconnect(generation);
		};
	}

	#scheduleReconnect(generation: number): void {
		if (
			generation !== this.#operationGeneration ||
			!this.#auth.isAuthenticated() ||
			this.#reconnectTimer !== null
		) {
			return;
		}

		this.#reconnectTimer = window.setTimeout(() => {
			this.#reconnectTimer = null;
			if (generation === this.#operationGeneration) {
				void this.#openWithTicket(generation);
			}
		}, this.#reconnectDelayMs.next());
	}

	#closeCurrentConnection(): void {
		if (this.#reconnectTimer !== null) {
			window.clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
		const socket = this.#socket;
		this.#socket = null;
		if (socket) socket.close();
		this.#reconnectDelayMs.reset();
	}

	/** Creates a backoff that increases after a reconnection */
	#creatBackoff({ base = 500, max = 30000, jitter = true } = {}): backOff {
		let localGeneration = this.#operationGeneration;
		return {
			next() {
				const exponential = Math.min(
					base * Math.pow(2, localGeneration),
					max,
				);
				const delay = jitter
					? exponential * (0.5 + Math.random() * 0.5)
					: exponential;
				localGeneration++;
				return Math.floor(delay);
			},
			reset() {
				localGeneration = 0;
			},
		};
	}
}
