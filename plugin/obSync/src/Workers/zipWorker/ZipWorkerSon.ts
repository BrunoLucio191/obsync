import { App, Notice, requestUrl } from 'obsidian';
import { PathMuteRegistry } from '../../vault/PathMuteRegistry.ts';
import { AuthService } from '../../auth/AuthService.ts';
import { t } from '../../i18n/i18n.ts';
import { getApiBaseUrl } from '../../config/ApiConfig.ts';
import zipWorkerSource from './zip.worker.generated.ts';
import { ZipWorkerMessage } from './zip.worker.ts';

/**
 * Fetches the remote vault zip on the main thread (the only place with
 * access to the Obsidian API), hands the raw bytes off to a real Worker to
 * unzip off the main thread, then writes the extracted entries back into the
 * vault once the worker reports its result.
 */
export class ZipWorkerSon {
	private zipWoker!: Worker;
	constructor(
		private readonly app: App,
		private readonly mutedPath: PathMuteRegistry,
		private readonly auth: AuthService,
	) {}
	public async startWorking(): Promise<void> {
		if (!(await this.auth.prepareAuthenticatedRequest())) {
			new Notice(t('sync.initialSyncFailed'));
			return;
		}

		const response = await requestUrl({
			url: `${getApiBaseUrl()}/api/syncfiles`,
			method: 'POST',
			headers: this.auth.headers(),
			body: JSON.stringify({ myFlag: true, name: 'obsidian ready to sync' }),
			throw: false,
		});

		if (response.status !== 200) {
			console.error(t('sync.initialSyncError'), t('sync.serverReturnError'), {
				status: response.status,
			});
			new Notice(t('sync.initialSyncFailed'));
			return;
		}

		const blob = new Blob([zipWorkerSource], { type: 'application/javascript' });
		this.zipWoker = new Worker(URL.createObjectURL(blob));

		this.app.workspace.onLayoutReady(() => {
			this.zipWoker.onmessage = (event: MessageEvent<ZipWorkerMessage>) => {
				void this.handleZipResult(event.data);
			};
		});

		this.zipWoker.onerror = (event) => {
			console.error(t('sync.initialSyncError'), event.error ?? event.message);
			new Notice(t('sync.initialSyncFailed'));
		};

		const zipData = response.arrayBuffer;
		this.zipWoker.postMessage(zipData, [zipData]);
	}

	/**
	 * Handles the worker's result: on success, writes every extracted entry into the
	 * vault (creating parent folders as needed), muting each path first so the
	 * resulting vault events aren't re-published back to the server. Admins always get
	 * the latest file content; non-admins only get files that don't already exist
	 * locally, so local-only content survives for read-only users.
	 */
	private async handleZipResult(message: ZipWorkerMessage) {
		this.zipWoker.terminate();

		if (message.status === 'error') {
			console.error(t('sync.initialSyncError'), message.message);
			new Notice(t('sync.initialSyncFailed'));
			return;
		}

		const adapter = this.app.vault.adapter;

		for (const entry of message.entries) {
			if (entry.isDir) {
				if (!(await adapter.exists(entry.path))) {
					this.mutedPath.mute(entry.path);
					await adapter.mkdir(entry.path);
				}
				continue;
			}

			const parentPath = entry.path.substring(0, entry.path.lastIndexOf('/'));
			if (parentPath && !(await adapter.exists(parentPath))) {
				this.mutedPath.mute(parentPath);
				await adapter.mkdir(parentPath);
			}
			if (this.auth.isAdmin() || !(await adapter.exists(entry.path))) {
				this.mutedPath.mute(entry.path);
				await adapter.writeBinary(entry.path, entry.content);
			}
		}
		new Notice(t('sync.initialSyncComplete'));
	}
}
