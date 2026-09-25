import { App, Notice, requestUrl } from 'obsidian';
import { PathMuteRegistry } from '../../vault/PathMuteRegistry.ts';
import { AuthService } from '../../auth/AuthService.ts';
import { t } from '../../i18n/i18n.ts';
import { getApiBaseUrl } from '../../config/ApiConfig.ts';
import zipWorkerSource from './zip.worker.generated.ts';
import { ZipWorkerMessage } from './zip.worker.ts';

const GENE_HEADER = 'X-ObSync-Gene';

/**
 * Fetches the remote vault zip on the main thread (the only place with
 * access to the Obsidian API), hands the raw bytes off to a real Worker to
 * unzip off the main thread, then writes the extracted entries back into the
 * vault once the worker reports its result.
 *
 * The request carries the vault gene saved in Obsidian's secret storage after the
 * last initial sync that fully completed. The server compares it with its own gene
 * and answers 204 when nothing changed, so the download is skipped.
 */
export class ZipWorkerSon {
	#zipWoker!: Worker;
	readonly #app: App;
	readonly #mutedPath: PathMuteRegistry;
	readonly #auth: AuthService;
	/** Gene the server sent along with the zip, saved only once every entry is written. */
	#receivedGene: string | null = null;

	constructor(app: App, mutedPath: PathMuteRegistry, auth: AuthService) {
		this.#app = app;
		this.#mutedPath = mutedPath;
		this.#auth = auth;
	}
	public async startWorking(): Promise<void> {
		if (!(await this.#auth.prepareAuthenticatedRequest())) {
			new Notice(t('sync.initialSyncFailed'));
			return;
		}

		const savedGene = this.#app.secretStorage.getSecret(this.#geneSecretId);
		const response = await requestUrl({
			url: `${getApiBaseUrl()}/api/sync/initSync`,
			method: 'POST',
			headers: {
				...this.#auth.Authheaders(),
				'Content-Disposition': 'attachment',
				...(savedGene ? { [GENE_HEADER]: savedGene } : {}),
			},
			body: JSON.stringify({ myFlag: true, name: 'obsidian ready to sync' }),
			throw: false,
		});
		// The server compared the genes: nothing changed since the last complete initial sync
		if (response.status === 204) {
			new Notice(t('sync.vaultUpToDate'));
			return;
		}
		if (response.status !== 200) {
			console.error(t('sync.initialSyncError'), t('sync.serverReturnError'), {
				status: response.status,
			});
			new Notice(t('sync.initialSyncFailed'));
			return;
		}

		this.#receivedGene =
			Object.entries(response.headers).find(
				([name]) => name.toLowerCase() === GENE_HEADER.toLowerCase(),
			)?.[1] ?? null;

		const blob = new Blob([zipWorkerSource], { type: 'application/javascript' });
		this.#zipWoker = new Worker(URL.createObjectURL(blob));

		this.#app.workspace.onLayoutReady(() => {
			this.#zipWoker.onmessage = (event: MessageEvent<ZipWorkerMessage>) => {
				void this.#handleZipResult(event.data);
			};
		});

		this.#zipWoker.onerror = (event) => {
			console.error(t('sync.initialSyncError'), event.error ?? event.message);
			new Notice(t('sync.initialSyncFailed'));
		};

		const zipData = response.arrayBuffer;
		this.#zipWoker.postMessage(zipData, [zipData]);
	}

	/**
	 * Handles the worker's result: on success, writes every extracted entry into the
	 * vault (creating parent folders as needed), muting each path first so the
	 * resulting vault events aren't re-published back to the server. Admins always get
	 * the latest file content; non-admins only get files that don't already exist
	 * locally, so local-only content survives for read-only users.
	 */
	async #handleZipResult(message: ZipWorkerMessage) {
		this.#zipWoker.terminate();

		if (message.status === 'error') {
			console.error(t('sync.initialSyncError'), message.message);
			new Notice(t('sync.initialSyncFailed'));
			return;
		}

		const adapter = this.#app.vault.adapter;

		for (const entry of message.entries) {
			if (entry.isDir) {
				if (!(await adapter.exists(entry.path))) {
					this.#mutedPath.mute(entry.path);
					await adapter.mkdir(entry.path);
				}
				continue;
			}

			const parentPath = entry.path.substring(0, entry.path.lastIndexOf('/'));
			if (parentPath && !(await adapter.exists(parentPath))) {
				this.#mutedPath.mute(parentPath);
				await adapter.mkdir(parentPath);
			}
			if (this.#auth.isAdmin() || !(await adapter.exists(entry.path))) {
				this.#mutedPath.mute(entry.path);
				await adapter.writeBinary(entry.path, entry.content);
			}
		}
		// Saved only now: an initial sync that stopped halfway must not look up to date next time
		if (this.#receivedGene) {
			this.#app.secretStorage.setSecret(this.#geneSecretId, this.#receivedGene);
		}
		new Notice(t('sync.initialSyncComplete'));
	}

	/**
	 * Secret id for this vault's gene. On mobile Obsidian keeps every vault's secrets
	 * under the same key, so the vault name goes into the id to keep them apart.
	 */
	get #geneSecretId(): string {
		const vaultName = this.#app.vault
			.getName()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-');
		return `obsync-vault-gene-${vaultName}`.slice(0, 64);
	}
}
