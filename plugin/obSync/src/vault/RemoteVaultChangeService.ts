import { Notice, requestUrl, type App } from 'obsidian';
import type { VaultChange } from './VaultChange.ts';
import type { AuthService } from '../auth/AuthService.ts';
import type { CollaborationController } from '../collab/CollaborationController.ts';
import { PathMuteRegistry } from './PathMuteRegistry.ts';
import { getApiBaseUrl } from '../config/ApiConfig.ts';
import type { QueueManager } from '../queue/QueueManager.ts';
import { t } from '../i18n/i18n.ts';
import { ensureParentFolder } from './ensureParentFolder.ts';
import type { ServerVersionMerger } from './ServerVersionMerger.ts';

/**
 * Applies vault changes from other clients, muting each path so the local event isn't
 * republished. Regular users never publish, so their files go through ServerVersionMerger.
 */
export class RemoteVaultChangeService {
	readonly #app: App;
	readonly #auth: AuthService;
	readonly #mutedPaths: PathMuteRegistry;
	readonly #collaboration: CollaborationController;
	readonly #queueManager: QueueManager;
	/** Binaries already gone when announced; a later rename says where they went. */
	readonly #missedBinaries = new Set<string>();
	readonly #merger: ServerVersionMerger;
	readonly #requestFullSync: () => void;

	public constructor(
		app: App,
		auth: AuthService,
		mutedPaths: PathMuteRegistry,
		collaboration: CollaborationController,
		queueManager: QueueManager,
		merger: ServerVersionMerger,
		requestFullSync: () => void,
	) {
		this.#app = app;
		this.#auth = auth;
		this.#mutedPaths = mutedPaths;
		this.#collaboration = collaboration;
		this.#queueManager = queueManager;
		this.#merger = merger;
		this.#requestFullSync = requestFullSync;
	}
	/** Add changes inside the client queue*/
	public async apply(change: VaultChange): Promise<void> {
		/** the oldpath is used as key because is the one that exists on the cliente */
		const path = change.type === 'rename' ? change.oldPath : change.path;
		const queue = this.#queueManager.getOrCreateQueue(this.#auth.clientId);

		try {
			await queue.addTask(
				() => this.#applyChange(change),
				`remote:${path}:${change.type}`,
			);
		} catch (error) {
			console.error(t('sync.applyRemoteChangeFailed', { path }), error);
		}
	}

	async #applyChange(change: VaultChange): Promise<void> {
		const adapter = this.#app.vault.adapter;

		if (change.type === 'create') {
			this.#mutedPaths.mute(change.path);
			if (change.isFolder) {
				if (!(await adapter.exists(change.path))) {
					await adapter.mkdir(change.path);
				}
				return;
			}
			if (change.isBinary) {
				if (!(await this.#downloadFile(change.path))) {
					this.#missedBinaries.add(change.path);
				}
				return;
			}
			await this.#writeServerFile(change.path, change.content ?? '');
			return;
		}

		if (change.type === 'modify') {
			await this.#writeServerFile(change.path, change.content);
			return;
		}

		if (change.type === 'delete') {
			for (const missed of [...this.#missedBinaries]) {
				if (PathMuteRegistry.contains(change.path, missed))
					this.#missedBinaries.delete(missed);
			}
			await this.#merger.forget(change.path);
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
			await ensureParentFolder(adapter, this.#mutedPaths, change.newPath);
			await adapter.rename(change.oldPath, change.newPath);
		} else if (
			this.#auth.isReadOnlyUser() &&
			!this.#missedBinaries.has(change.oldPath)
		) {
			await this.#followServerRename(
				change.oldPath,
				change.newPath,
				change.isFolder,
			);
		}
		await this.#merger.rename(change.oldPath, change.newPath);
		await this.#recoverMissedBinaries(change.oldPath, change.newPath);
		if (
			this.#collaboration.currentPath &&
			PathMuteRegistry.contains(
				change.oldPath,
				this.#collaboration.currentPath,
			)
		) {
			this.#collaboration.scheduleActiveRoomSync();
		}
	}

	/** The user moved what the admin renamed: an unedited copy follows, else the server's version is fetched. */
	async #followServerRename(
		oldPath: string,
		newPath: string,
		isFolder: boolean,
	): Promise<void> {
		const adapter = this.#app.vault.adapter;
		const movedCopy = isFolder
			? null
			: await this.#merger.findMovedCopy(oldPath);
		if (movedCopy && !(await adapter.exists(newPath))) {
			this.#mutedPaths.mute(movedCopy);
			await ensureParentFolder(adapter, this.#mutedPaths, newPath);
			await adapter.rename(movedCopy, newPath);
			new Notice(
				t('sync.adminMovedYourCopy', {
					oldPath,
					newPath,
					copyPath: movedCopy,
				}),
			);
			return;
		}

		if (isFolder) this.#requestFullSync();
		else await this.#downloadFile(newPath);
		new Notice(t('sync.adminMovedDownloaded', { oldPath, newPath }));
	}

	async #writeServerFile(
		path: string,
		data: string | ArrayBuffer,
	): Promise<void> {
		if (this.#auth.isReadOnlyUser()) {
			await this.#merger.apply(path, data);
			return;
		}
		const adapter = this.#app.vault.adapter;
		this.#mutedPaths.mute(path);
		await ensureParentFolder(adapter, this.#mutedPaths, path);
		if (typeof data === 'string') await adapter.write(path, data);
		else await adapter.writeBinary(path, data);
	}

	/** @returns `false` on 404: renamed or deleted before this client got to it. */
	async #downloadFile(path: string): Promise<boolean> {
		const params = new URLSearchParams({
			path,
			fileName: path.slice(path.lastIndexOf('/') + 1),
		});
		const response = await requestUrl({
			url: `${getApiBaseUrl()}/api/sync/getFile?${params}`,
			method: 'GET',
			headers: this.#auth.AuthHeaders(),
			throw: false,
		});
		if (response.status === 404) return false;
		if (response.status !== 200) {
			throw new Error(`getFile returned ${response.status} for ${path}`);
		}

		await this.#writeServerFile(path, response.arrayBuffer);
		return true;
	}

	async #recoverMissedBinaries(
		oldPath: string,
		newPath: string,
	): Promise<void> {
		for (const missed of [...this.#missedBinaries]) {
			if (!PathMuteRegistry.contains(oldPath, missed)) continue;
			this.#missedBinaries.delete(missed);
			const current = newPath + missed.slice(oldPath.length);
			if (!(await this.#downloadFile(current)))
				this.#missedBinaries.add(current);
		}
	}
}
