import {
	Plugin,
	TFile,
	TFolder,
	requestUrl,
	type TAbstractFile,
} from 'obsidian';
import { getApiBaseUrl } from '../config/ApiConfig.ts';
import type { AuthService } from '../auth/AuthService.ts';
import type { CollaborationController } from '../collab/CollaborationController.ts';
import { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';
import type { QueueManager } from '../queue/QueueManager.ts';
import { t } from '../i18n/i18n.ts';
import { BINARY_EXTENSIONS } from '../vault/binaryExtensions.ts';

/**
 * Publishes an admin's local vault events, one queue task each. Paths are read when the
 * event fires, because Obsidian renames the same file object in place.
 */
export class SyncVaultChanges {
	readonly #plugin: Plugin;
	readonly #auth: AuthService;
	readonly #mutedPaths: PathMuteRegistry;
	readonly #collaboration: CollaborationController;
	readonly #queueManager: QueueManager;
	/** Files deleted before their create was sent: their later tasks send nothing. */
	readonly #unpublished = new WeakSet<TAbstractFile>();

	public constructor(
		plugin: Plugin,
		auth: AuthService,
		mutedPaths: PathMuteRegistry,
		collaboration: CollaborationController,
		queueManager: QueueManager,
	) {
		this.#plugin = plugin;
		this.#auth = auth;
		this.#mutedPaths = mutedPaths;
		this.#collaboration = collaboration;
		this.#queueManager = queueManager;
	}

	public initialize(): void {
		this.#plugin.registerEvent(
			this.#plugin.app.vault.on('create', async (file) => {
				const path = file.path;
				if (!this.#shouldPublish(path)) return;

				const queue = this.#queueManager.getOrCreateQueue(
					this.#auth.clientId,
				);
				try {
					await queue.addTask(async () => {
						// Deleted before it was sent: skip it and what follows
						if (this.#isGone(file)) {
							this.#unpublished.add(file);
							return;
						}
						if (!(await this.#canSendRequest())) return;

						if (
							file instanceof TFile &&
							BINARY_EXTENSIONS.has(file.extension.toLowerCase())
						) {
							const buffer =
								await this.#plugin.app.vault.readBinary(file);
							if (buffer.byteLength > 0) {
								await this.#uploadBinary(path, buffer);
								return;
							}
						}

						const isFolder = file instanceof TFolder;
						const content =
							file instanceof TFile
								? await this.#plugin.app.vault.read(file)
								: null;
						await requestUrl({
							url: `${getApiBaseUrl()}/api/sync/create`,
							method: 'POST',
							headers: this.#auth.headers(),
							body: JSON.stringify({
								path,
								isFolder,
								content,
							}),
						});
					}, `local:${path}:create`);
				} catch (error) {
					console.error(
						t('sync.publishChangeFailed', { path }),
						error,
					);
				}
			}),
		);

		this.#plugin.registerEvent(
			this.#plugin.app.vault.on('delete', async (file) => {
				const path = file.path;
				if (!this.#shouldPublish(path)) return;

				const isFolder = file instanceof TFolder;
				this.#collaboration.disconnectIfAffected(path);

				const queue = this.#queueManager.getOrCreateQueue(
					this.#auth.clientId,
				);
				try {
					await queue.addTask(async () => {
						if (this.#unpublished.has(file)) return;
						if (!(await this.#canSendRequest())) return;

						await requestUrl({
							url: `${getApiBaseUrl()}/api/sync/delete`,
							method: 'DELETE',
							headers: this.#auth.headers(),
							body: JSON.stringify({ path, isFolder }),
						});
					}, `local:${path}:delete`);
				} catch (error) {
					console.error(
						t('sync.publishChangeFailed', { path }),
						error,
					);
				}
			}),
		);

		this.#plugin.registerEvent(
			this.#plugin.app.vault.on('modify', async (file) => {
				const path = file.path;
				if (!this.#shouldPublish(path)) return;
				const activeFile = this.#plugin.app.workspace.getActiveFile();
				if (activeFile && path === activeFile.path) return;
				if (!(file instanceof TFile)) return;

				const queue = this.#queueManager.getOrCreateQueue(
					this.#auth.clientId,
				);
				try {
					await queue.addTask(async () => {
						// Deleted since: the queued delete handles it
						if (this.#unpublished.has(file) || this.#isGone(file))
							return;
						if (!(await this.#canSendRequest())) return;

						// As bytes: reading a binary as text corrupts it
						if (
							BINARY_EXTENSIONS.has(file.extension.toLowerCase())
						) {
							const buffer =
								await this.#plugin.app.vault.readBinary(file);
							if (buffer.byteLength > 0) {
								await this.#uploadBinary(path, buffer);
								return;
							}
						}

						const content = await this.#plugin.app.vault.read(file);
						await requestUrl({
							url: `${getApiBaseUrl()}/api/sync/modify`,
							method: 'PUT',
							headers: this.#auth.headers(),
							body: JSON.stringify({ path, content }),
						});
					}, `local:${path}:modify`);
				} catch (error) {
					console.error(
						t('sync.publishChangeFailed', { path }),
						error,
					);
				}
			}),
		);

		this.#plugin.registerEvent(
			this.#plugin.app.vault.on('rename', async (file, oldPath) => {
				const newPath = file.path;
				if (!this.#shouldPublish(newPath, oldPath)) return;

				const queue = this.#queueManager.getOrCreateQueue(
					this.#auth.clientId,
				);
				try {
					await queue.addTask(async () => {
						if (this.#unpublished.has(file)) return;
						if (!(await this.#canSendRequest())) return;

						const response = await requestUrl({
							url: `${getApiBaseUrl()}/api/sync/rename`,
							method: 'PUT',
							headers: this.#auth.headers(),
							body: JSON.stringify({ oldPath, newPath }),
							throw: false,
						});
						// 404: the server never had the source
						if (response.status === 404) return;
						if (response.status >= 400) {
							throw new Error(
								`rename returned ${response.status}`,
							);
						}

						if (
							this.#collaboration.currentPath &&
							PathMuteRegistry.contains(
								oldPath,
								this.#collaboration.currentPath,
							)
						) {
							this.#collaboration.scheduleActiveRoomSync();
						}
					}, `local:${oldPath}:rename`);
				} catch (error) {
					console.error(
						t('sync.publishChangeFailed', { path: oldPath }),
						error,
					);
				}
			}),
		);
	}

	/** Checked when the event fires, not in the task: keeps event order,
	 * and a mute can't expire in the queue. */
	#shouldPublish(...paths: string[]): boolean {
		return (
			this.#auth.isAdmin() &&
			!paths.some((path) => this.#mutedPaths.isMuted(path))
		);
	}

	#isGone(file: TAbstractFile): boolean {
		return this.#plugin.app.vault.getAbstractFileByPath(file.path) !== file;
	}

	async #uploadBinary(path: string, buffer: ArrayBuffer): Promise<void> {
		await requestUrl({
			url: `${getApiBaseUrl()}/api/sync/createFile`,
			method: 'POST',
			headers: {
				...this.#auth.AuthHeaders(),
				'Content-Type': 'application/octet-stream',
				'X-ObSync-filePath': path,
			},
			body: buffer,
		});
	}

	async #canSendRequest(): Promise<boolean> {
		return (
			(await this.#auth.prepareAuthenticatedRequest()) &&
			this.#auth.isAdmin()
		);
	}
}
