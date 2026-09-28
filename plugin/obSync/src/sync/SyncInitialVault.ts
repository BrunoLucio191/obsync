import type { App } from 'obsidian';
import { AuthService } from '../auth/AuthService.ts';
import type { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';
import { ZipWorkerSon } from '../Workers/zipWorker/ZipWorkerSon.ts';
import { Boss } from '../Workers/Boss.ts';
import type { QueueManager } from '../queue/QueueManager.ts';
import type { ServerVersionMerger } from '../vault/ServerVersionMerger.ts';
/** Downloads the whole vault as a zip and writes it into the local vault. */
export class SyncInitialVault {
	#boss!: Boss;
	readonly #app: App;
	readonly #auth: AuthService;
	readonly #mutedPaths: PathMuteRegistry;
	readonly #queueManager: QueueManager;
	readonly #merger: ServerVersionMerger;

	constructor(
		app: App,
		auth: AuthService,
		mutedPaths: PathMuteRegistry,
		queueManager: QueueManager,
		merger: ServerVersionMerger,
	) {
		this.#app = app;
		this.#auth = auth;
		this.#mutedPaths = mutedPaths;
		this.#queueManager = queueManager;
		this.#merger = merger;
	}

	public async sync(): Promise<void> {
		this.#boss = new Boss(
			new ZipWorkerSon(this.#app, this.#mutedPaths, this.#auth, this.#queueManager, this.#merger),
		);
		await this.#boss.startWorking();
	}
}
