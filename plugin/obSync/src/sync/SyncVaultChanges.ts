import { Plugin, TFile, TFolder, requestUrl } from 'obsidian';
import { getApiBaseUrl } from '../config/ApiConfig.ts';
import type { AuthService } from '../auth/AuthService.ts';
import type { CollaborationController } from '../collab/CollaborationController.ts';
import { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';

export class SyncVaultChanges {
	public constructor(
		private readonly plugin: Plugin,
		private readonly auth: AuthService,
		private readonly mutedPaths: PathMuteRegistry,
		private readonly collaboration: CollaborationController,
	) {}

	public initialize(): void {
		this.plugin.registerEvent(
			this.plugin.app.vault.on('create', async (file) => {
				if (!(await this.canPublish(file.path))) return;
				const isFolder = file instanceof TFolder;
				const content =
					!isFolder && file instanceof TFile
						? await this.plugin.app.vault.read(file)
						: null;

				await requestUrl({
					url: `${getApiBaseUrl()}/sync/create`,
					method: 'POST',
					headers: this.auth.headers(),
					body: JSON.stringify({
						path: file.path,
						isFolder,
						content,
					}),
				});
			}),
		);

		this.plugin.registerEvent(
			this.plugin.app.vault.on('delete', async (file) => {
				if (!(await this.canPublish(file.path))) return;

				const isFolder = file instanceof TFolder;
				this.collaboration.disconnectIfAffected(file.path);

				await requestUrl({
					url: `${getApiBaseUrl()}/sync/delete`,
					method: 'DELETE',
					headers: this.auth.headers(),
					body: JSON.stringify({ path: file.path, isFolder }),
				});
			}),
		);

		this.plugin.registerEvent(
			this.plugin.app.vault.on('modify', async (file) => {
				if (!(await this.canPublish(file.path))) return;
				const activeFile = this.plugin.app.workspace.getActiveFile();
				// Yjs takes care of the active file, so we don't fire the PUT for it
				if (activeFile && file.path === activeFile.path) return;

				if (file instanceof TFile) {
					const content = await this.plugin.app.vault.read(file);
					await requestUrl({
						url: `${getApiBaseUrl()}/sync/modify`,
						method: 'PUT',
						headers: this.auth.headers(),
						body: JSON.stringify({ path: file.path, content }),
					});
				}
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.vault.on('rename', async (file, oldPath) => {
				if (!(await this.canPublish(file.path, oldPath))) return;

				await requestUrl({
					url: `${getApiBaseUrl()}/sync/rename`,
					method: 'PUT',
					headers: this.auth.headers(),
					body: JSON.stringify({ oldPath, newPath: file.path }),
				});

				if (
					this.collaboration.currentPath &&
					PathMuteRegistry.contains(
						oldPath,
						this.collaboration.currentPath,
					)
				) {
					this.collaboration.scheduleActiveRoomSync();
				}
			}),
		);
	}

	private async canPublish(...paths: string[]): Promise<boolean> {
		if (
			!this.auth.isAdmin() ||
			paths.some((path) => this.mutedPaths.isMuted(path)) ||
			!(await this.auth.prepareAuthenticatedRequest())
		) {
			return false;
		}

		return this.auth.isAdmin();
	}
}
