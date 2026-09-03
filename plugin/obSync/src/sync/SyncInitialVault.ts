import type { App } from 'obsidian';
import { AuthService } from '../auth/AuthService.ts';
import type { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';
import { ZipWorkerSon } from '../Workers/zipWorker/ZipWorkerSon.ts';
import { Boss } from '../Workers/Boss.ts';
/**
 * Performs the one-time bulk sync that downloads the remote vault as a zip and
 * writes it into the local Obsidian vault, used when the plugin first connects
 * a vault to the backend (or needs to re-baseline it).
 */
export class SyncInitialVault {
	private boss!: Boss;
	constructor(
		private readonly app: App,
		private readonly auth: AuthService,
		private readonly mutedPaths: PathMuteRegistry,
	) {}

	/**
	 * Fetches the remote vault snapshot as a zip archive and extracts it into
	 * the local vault. Existing folders are left alone; for admins, files are
	 * always overwritten, while non-admins only get files that don't already
	 * exist locally (so local-only content survives for read-only users).
	 * Every path written is muted first so the resulting vault events aren't
	 * re-published back to the server. Shows a success or failure Notice.
	 */
	public async sync(): Promise<void> {
		this.boss = new Boss(new ZipWorkerSon(this.app, this.mutedPaths, this.auth));
		await this.boss.startWorking();
	}
}
