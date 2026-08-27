import { requestUrl, Notice } from 'obsidian';
import { getApiBaseUrl } from '../config/ApiConfig.ts';
import JSZip from 'jszip';
import { t } from '../i18n/i18n.ts';
import type { App } from 'obsidian';
import type { AuthService } from '../auth/AuthService.ts';
import type { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';

/** Fixed request body sent to the sync-files endpoint (server-side marker, not currently parameterized). */
const payload = {
	myFlag: true,
	name: 'obsidian ready to sync',
};

/**
 * Performs the one-time bulk sync that downloads the remote vault as a zip and
 * writes it into the local Obsidian vault, used when the plugin first connects
 * a vault to the backend (or needs to re-baseline it).
 */
export class SyncInitialVault {
	public constructor(
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
		try {
			if (!(await this.auth.prepareAuthenticatedRequest())) {
				throw new Error(t('sync.invalidOrExpiredSession'));
			}
			const response = await requestUrl({
				url: `${getApiBaseUrl()}/api/syncfiles`,
				method: 'POST',
				headers: this.auth.headers(),
				body: JSON.stringify(payload),
			});

			if (response.status !== 200) {
				throw new Error(
					t('sync.serverReturnedError', { status: response.status }),
				);
			}
			const zip = await JSZip.loadAsync(response.arrayBuffer);
			const adapter = this.app.vault.adapter;

			for (const relativePath of Object.keys(zip.files)) {
				const entry = zip.files[relativePath];
				if (!entry) continue;

				if (entry.dir) {
					if (!(await adapter.exists(relativePath))) {
						this.mutedPaths.mute(relativePath);
						await adapter.mkdir(relativePath);
					}
				} else {
					const content = await entry.async('arraybuffer');
					const parentPath = relativePath.substring(
						0,
						relativePath.lastIndexOf('/'),
					);

					if (parentPath && !(await adapter.exists(parentPath))) {
						this.mutedPaths.mute(parentPath);
						await adapter.mkdir(parentPath);
					}
					if (
						this.auth.isAdmin() ||
						!(await adapter.exists(relativePath))
					) {
						this.mutedPaths.mute(relativePath);
						await adapter.writeBinary(relativePath, content);
					}
				}
			}
			new Notice(t('sync.initialSyncComplete'));
		} catch (error) {
			console.error(t('sync.initialSyncError'), error);
			new Notice(t('sync.initialSyncFailed'));
		}
	}
}
