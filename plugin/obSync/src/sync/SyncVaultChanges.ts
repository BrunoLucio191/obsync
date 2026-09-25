import { Plugin, TFile, TFolder, requestUrl } from 'obsidian';
import { getApiBaseUrl } from '../config/ApiConfig.ts';
import type { AuthService } from '../auth/AuthService.ts';
import type { CollaborationController } from '../collab/CollaborationController.ts';
import { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';
import type { QueueManager } from '../queue/QueueManager.ts';
import { t } from '../i18n/i18n.ts';

/**
 * Extensions uploaded as raw bytes to `/api/sync/createFile` instead of as text:
 * the attachments Obsidian can embed plus other files users commonly keep in a vault.
 */
const BINARY_EXTENSIONS = new Set([
	// images
	'avif', 'bmp', 'gif', 'heic', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp',
	// audio
	'3gp', 'aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'webm',
	// video
	'avi', 'mkv', 'mov', 'mp4', 'ogv',
	// documents
	'pdf', 'epub', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
	// archives
	'zip', 'rar', '7z', 'tar', 'gz',
]);

/**
 * Listens for local Obsidian vault events (create/delete/modify/rename) made
 * by an admin and publishes them to the backend so other clients receive the
 * change. Non-admin edits are never published (admins own the shared vault).
 *
 * Every publish runs as a task in this client's queue, the same one used by
 * {@link RemoteVaultChangeService}, so local and remote changes are handled
 * one at a time in the order they happened. Paths are read when the event
 * fires, because Obsidian renames the same file object in place and the task
 * may only run later.
 */
export class SyncVaultChanges {
	readonly #plugin: Plugin;
	readonly #auth: AuthService;
	readonly #mutedPaths: PathMuteRegistry;
	readonly #collaboration: CollaborationController;
	readonly #queueManager: QueueManager;

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

	/**
	 * Registers the vault event listeners (`create`, `delete`, `modify`,
	 * `rename`) that forward local changes to the corresponding `/api/sync/*`
	 * backend endpoints. Muted paths (changes caused by applying a remote
	 * update) are skipped to avoid echoing changes back to their origin.
	 */
	public initialize(): void {
		this.#plugin.registerEvent(
			this.#plugin.app.vault.on('create', async (file) => {
				const path = file.path;
				if (!this.#shouldPublish(path)) return;

				const queue = this.#queueManager.getOrCreateQueue(this.#auth.clientId);
				try {
					await queue.addTask(async () => {
						if (!(await this.#canSendRequest())) return;

						if (
							file instanceof TFile &&
							BINARY_EXTENSIONS.has(file.extension.toLowerCase())
						) {
							const buffer = await this.#plugin.app.vault.readBinary(file);
							// An empty binary has no bytes to upload, so it goes through /create below
							if (buffer.byteLength > 0) {
								await requestUrl({
									url: `${getApiBaseUrl()}/api/sync/createFile`,
									method: 'POST',
									headers: {
										...this.#auth.Authheaders(),
										'Content-Type': 'application/octet-stream',
										'X-ObSync-filePath': path,
									},
									body: buffer,
								});
								return;
							}
						}

						const isFolder = file instanceof TFolder;
						const content =
							file instanceof TFile ? await this.#plugin.app.vault.read(file) : null;
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
					console.error(t('sync.publishChangeFailed', { path }), error);
				}
			}),
		);

		this.#plugin.registerEvent(
			this.#plugin.app.vault.on('delete', async (file) => {
				const path = file.path;
				if (!this.#shouldPublish(path)) return;

				const isFolder = file instanceof TFolder;
				this.#collaboration.disconnectIfAffected(path);

				const queue = this.#queueManager.getOrCreateQueue(this.#auth.clientId);
				try {
					await queue.addTask(async () => {
						if (!(await this.#canSendRequest())) return;

						await requestUrl({
							url: `${getApiBaseUrl()}/api/sync/delete`,
							method: 'DELETE',
							headers: this.#auth.headers(),
							body: JSON.stringify({ path, isFolder }),
						});
					}, `local:${path}:delete`);
				} catch (error) {
					console.error(t('sync.publishChangeFailed', { path }), error);
				}
			}),
		);

		this.#plugin.registerEvent(
			this.#plugin.app.vault.on('modify', async (file) => {
				const path = file.path;
				if (!this.#shouldPublish(path)) return;
				const activeFile = this.#plugin.app.workspace.getActiveFile();
				// Yjs takes care of the active file, so we don't fire the PUT for it
				if (activeFile && path === activeFile.path) return;
				if (!(file instanceof TFile)) return;

				const queue = this.#queueManager.getOrCreateQueue(this.#auth.clientId);
				try {
					await queue.addTask(async () => {
						if (!(await this.#canSendRequest())) return;

						const content = await this.#plugin.app.vault.read(file);
						await requestUrl({
							url: `${getApiBaseUrl()}/api/sync/modify`,
							method: 'PUT',
							headers: this.#auth.headers(),
							body: JSON.stringify({ path, content }),
						});
					}, `local:${path}:modify`);
				} catch (error) {
					console.error(t('sync.publishChangeFailed', { path }), error);
				}
			}),
		);

		this.#plugin.registerEvent(
			this.#plugin.app.vault.on('rename', async (file, oldPath) => {
				const newPath = file.path;
				if (!this.#shouldPublish(newPath, oldPath)) return;

				const queue = this.#queueManager.getOrCreateQueue(this.#auth.clientId);
				try {
					await queue.addTask(async () => {
						if (!(await this.#canSendRequest())) return;

						await requestUrl({
							url: `${getApiBaseUrl()}/api/sync/rename`,
							method: 'PUT',
							headers: this.#auth.headers(),
							body: JSON.stringify({ oldPath, newPath }),
						});

						if (
							this.#collaboration.currentPath &&
							PathMuteRegistry.contains(oldPath, this.#collaboration.currentPath)
						) {
							this.#collaboration.scheduleActiveRoomSync();
						}
					}, `local:${oldPath}:rename`);
				} catch (error) {
					console.error(t('sync.publishChangeFailed', { path: oldPath }), error);
				}
			}),
		);
	}

	/**
	 * Decides, as soon as the vault event fires, whether the change should be
	 * published: only admins publish, and muted paths (from applying a remote
	 * change) are excluded. It is synchronous on purpose: tasks are queued in
	 * the same order the events happened, and a mute can't expire while the
	 * task waits its turn in the queue.
	 * @param paths - One or more vault paths involved in the change (e.g. old and new path for a rename).
	 * @returns `true` if the change should be published.
	 */
	#shouldPublish(...paths: string[]): boolean {
		return this.#auth.isAdmin() && !paths.some((path) => this.#mutedPaths.isMuted(path));
	}

	/**
	 * Checked inside the task, right before the request: the session must still
	 * be authenticated (refreshing it if needed) and still belong to an admin.
	 */
	async #canSendRequest(): Promise<boolean> {
		return (await this.#auth.prepareAuthenticatedRequest()) && this.#auth.isAdmin();
	}
}
