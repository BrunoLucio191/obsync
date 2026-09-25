import { requestUrl, type App } from 'obsidian';
import type { VaultChange } from './VaultChange.ts';
import type { AuthService } from '../auth/AuthService.ts';
import type { CollaborationController } from '../collab/CollaborationController.ts';
import { PathMuteRegistry } from './PathMuteRegistry.ts';
import { getApiBaseUrl } from '../config/ApiConfig.ts';
import type { QueueManager } from '../queue/QueueManager.ts';
import { t } from '../i18n/i18n.ts';

/**
 * Applies vault changes received from other clients (via {@link SystemChannel})
 * to the local Obsidian vault: writing/creating/deleting/renaming files and
 * folders. Every affected path is muted first so applying the change doesn't
 * trigger a local vault event that gets re-published back to the server.
 *
 * Changes are applied as tasks in this client's queue, the same one used by
 * {@link SyncVaultChanges}, so they never run concurrently with each other or
 * with a local change being published.
 */
export class RemoteVaultChangeService {
	readonly #app: App;
	readonly #auth: AuthService;
	readonly #mutedPaths: PathMuteRegistry;
	readonly #collaboration: CollaborationController;
	readonly #queueManager: QueueManager;

	public constructor(
		app: App,
		auth: AuthService,
		mutedPaths: PathMuteRegistry,
		collaboration: CollaborationController,
		queueManager: QueueManager,
	) {
		this.#app = app;
		this.#auth = auth;
		this.#mutedPaths = mutedPaths;
		this.#collaboration = collaboration;
		this.#queueManager = queueManager;
	}

	/**
	 * Queues a remote vault change to be applied to the local vault. Failures
	 * are logged instead of thrown.
	 * @param change - The remote change to apply.
	 */
	public async apply(change: VaultChange): Promise<void> {
		const path = change.type === 'rename' ? change.oldPath : change.path;
		const queue = this.#queueManager.getOrCreateQueue(this.#auth.clientId);
		try {
			await queue.addTask(() => this.#applyChange(change), `remote:${path}:${change.type}`);
		} catch (error) {
			console.error(t('sync.applyRemoteChangeFailed', { path }), error);
		}
	}

	/**
	 * Applies a single remote vault change to the local vault. For read-only
	 * users, `create`/`modify` are skipped when the local file already exists,
	 * so their local edits aren't clobbered by remote history. Deletes trash
	 * the file when Obsidian is tracking it (so it can be recovered), falling
	 * back to a raw adapter removal otherwise. Renames create any missing
	 * parent folders before moving the file.
	 * @param change - The remote change to apply.
	 */
	async #applyChange(change: VaultChange): Promise<void> {
		const adapter = this.#app.vault.adapter;

		if (change.type === 'create') {
			if (this.#auth.isReadOnlyUser() && (await adapter.exists(change.path))) {
				return;
			}

			this.#mutedPaths.mute(change.path);
			if (change.isBinary) {
				let fileName = null;
				if (!change.path.includes('/')) {
					fileName = change.path;
				} else {
					fileName = change.path.slice(
						change.path.lastIndexOf('/') + 1,
						change.path.length,
					);
				}
				const params = new URLSearchParams({
					path: change.path,
					fileName: fileName,
				});
				const response = await requestUrl({
					url: `${getApiBaseUrl()}/api/sync/getFile?${params}`,
					method: 'GET',
					headers: this.#auth.Authheaders(),
				});
				if (response.status !== 200) {
					console.error('Error when downloading tha file');
				}
				this.#mutedPaths.mute(change.path);
				await this.#ensureParentFolder(change.path);
				await adapter.writeBinary(change.path, response.arrayBuffer);
				return;
			}
			if (change.isFolder) {
				if (!(await adapter.exists(change.path))) {
					await adapter.mkdir(change.path);
				}
			} else {
				await this.#ensureParentFolder(change.path);
				await adapter.write(change.path, change.content!);
			}
			return;
		}

		if (change.type === 'modify') {
			if (this.#auth.isReadOnlyUser() && (await adapter.exists(change.path))) {
				return;
			}

			this.#mutedPaths.mute(change.path);
			await this.#ensureParentFolder(change.path);
			await adapter.write(change.path, change.content);

			return;
		}

		if (change.type === 'delete') {
			this.#collaboration.disconnectIfAffected(change.path);
			this.#mutedPaths.mute(change.path);

			const file = this.#app.vault.getAbstractFileByPath(change.path);
			if (file) {
				await this.#app.fileManager.trashFile(file);
				return;
			}

			if (!(await adapter.exists(change.path))) return;
			if (change.isFolder) {
				await adapter.rmdir(change.path, true);
			} else {
				await adapter.remove(change.path);
			}
			return;
		}

		this.#mutedPaths.mute(change.oldPath);
		this.#mutedPaths.mute(change.newPath);
		if (await adapter.exists(change.oldPath)) {
			await this.#ensureParentFolder(change.newPath);
			await adapter.rename(change.oldPath, change.newPath);
		}
	}

	/**
	 * Creates any missing folders in the path leading up to (but not
	 * including) a file, muting each one created so the resulting vault
	 * events aren't republished.
	 * @param filePath - Vault-relative file path whose parent folders should exist.
	 */
	async #ensureParentFolder(filePath: string): Promise<void> {
		const parent = filePath.substring(0, filePath.lastIndexOf('/'));
		if (!parent) return;

		const adapter = this.#app.vault.adapter;
		const parts = parent.split('/');
		let current = '';

		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await adapter.exists(current))) {
				this.#mutedPaths.mute(current);
				await adapter.mkdir(current);
			}
		}
	}
}
