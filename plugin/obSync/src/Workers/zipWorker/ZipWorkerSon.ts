import { App, Notice, requestUrl } from 'obsidian';
import { PathMuteRegistry } from '../../vault/PathMuteRegistry.ts';
import { AuthService } from '../../auth/AuthService.ts';
import { t } from '../../i18n/i18n.ts';
import { getApiBaseUrl } from '../../config/ApiConfig.ts';
import zipWorkerSource from './zip.worker.generated.ts';
import type { ZipWorkerEntry, ZipWorkerMessage } from './zip.worker.ts';
import type { QueueManager } from '../../queue/QueueManager.ts';
import type { ServerVersionMerger } from '../../vault/ServerVersionMerger.ts';
import { ensureParentFolder } from '../../vault/ensureParentFolder.ts';

const GENE_HEADER = 'X-ObSync-Gene';

/**
 * Downloads on the main thread (the only one with the Obsidian API) and unzips in a Worker.
 * Skipped while the gene saved after the last complete sync still matches the server's.
 */
export class ZipWorkerSon {
	#zipWoker!: Worker;
	readonly #app: App;
	readonly #mutedPath: PathMuteRegistry;
	readonly #auth: AuthService;
	readonly #queueManager: QueueManager;
	readonly #merger: ServerVersionMerger;
	#receivedGene: string | null = null;

	constructor(
		app: App,
		mutedPath: PathMuteRegistry,
		auth: AuthService,
		queueManager: QueueManager,
		merger: ServerVersionMerger,
	) {
		this.#app = app;
		this.#mutedPath = mutedPath;
		this.#auth = auth;
		this.#queueManager = queueManager;
		this.#merger = merger;
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
				...this.#auth.AuthHeaders(),
				'Content-Disposition': 'attachment',
				...(savedGene ? { ...this.#auth.GeneHeader(savedGene) } : {}),
			},
			body: JSON.stringify({
				myFlag: true,
				name: 'obsidian ready to sync',
			}),
			throw: false,
		});
		//Gene matches
		if (response.status === 204) {
			new Notice(t('sync.vaultUpToDate'));
			return;
		}
		if (response.status !== 200) {
			console.error(
				t('sync.initialSyncError'),
				t('sync.serverReturnError'),
				{
					status: response.status,
				},
			);
			new Notice(t('sync.initialSyncFailed'));
			return;
		}

		// Object.entries() returns key values pair inside an array.
		// find the gene header value and stores it
		this.#receivedGene =
			Object.entries(response.headers).find(
				([name]) => name.toLowerCase() === GENE_HEADER.toLowerCase(),
			)?.[1] ?? null;

		const blob = new Blob([zipWorkerSource], {
			type: 'application/javascript',
		});
		this.#zipWoker = new Worker(URL.createObjectURL(blob));

		this.#app.workspace.onLayoutReady(() => {
			this.#zipWoker.onmessage = (
				event: MessageEvent<ZipWorkerMessage>,
			) => {
				void this.#handleZipResult(event.data);
			};
		});

		this.#zipWoker.onerror = (event) => {
			console.error(
				t('sync.initialSyncError'),
				event.error ?? event.message,
			);
			new Notice(t('sync.initialSyncFailed'));
		};

		const zipData = response.arrayBuffer;
		this.#zipWoker.postMessage(zipData, [zipData]);
	}

	async #handleZipResult(message: ZipWorkerMessage) {
		this.#zipWoker.terminate();

		if (message.status === 'error') {
			console.error(t('sync.initialSyncError'), message.message);
			new Notice(t('sync.initialSyncFailed'));
			return;
		}

		const queue = this.#queueManager.getOrCreateQueue(this.#auth.clientId);
		try {
			await queue.addTask(
				() => this.#writeEntries(message.entries),
				'vault:InitialSync',
			);
		} catch (error) {
			console.error(t('sync.initialSyncError'), error);
			new Notice(t('sync.initialSyncFailed'));
			return;
		}
		if (this.#receivedGene) {
			this.#app.secretStorage.setSecret(
				this.#geneSecretId,
				this.#receivedGene,
			);
		}
		new Notice(t('sync.initialSyncComplete'));
	}

	/** Admins take the server's files as they are; regular users go through the merger. */
	async #writeEntries(entries: ZipWorkerEntry[]): Promise<void> {
		const adapter = this.#app.vault.adapter;
		for (const entry of entries) {
			if (entry.isDir) {
				if (!(await adapter.exists(entry.path))) {
					this.#mutedPath.mute(entry.path);
					await adapter.mkdir(entry.path);
				}
				continue;
			}
			if (!this.#auth.isAdmin()) {
				if (entry.isDir == false) {
					await this.#merger.apply(entry.path, entry.content);
					continue;
				}
			}
			this.#mutedPath.mute(entry.path);
			await ensureParentFolder(adapter, this.#mutedPath, entry.path);
			if (entry.isDir == false) {
				await adapter.writeBinary(entry.path, entry.content);
			}
		}
	}

	/** Mobile shares secrets across vaults, so the vault name goes into the id. */
	get #geneSecretId(): string {
		const vaultName = this.#app.vault
			.getName()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-');
		return `obsync-vault-gene-${vaultName}`.slice(0, 64);
	}
}
