import ObSync from '../main.ts';
import { TFile, TFolder, requestUrl } from 'obsidian';
import { API_BASE_URL } from '../constants.ts';

export class SyncVaultChanges {
	private obSync: ObSync;
	constructor(obSync: ObSync) {
		this.obSync = obSync;
	}
	public async initialize() {
		await this.eventsRegister();
	}
	public async eventsRegister(): Promise<void> {
		this.obSync.registerEvent(
			this.obSync.app.vault.on('create', async (file) => {
				if (
					!this.obSync.canPublishGlobalChanges() ||
					this.obSync.isMuted(file.path)
				)
					return;
				const isFolder = file instanceof TFolder;
				const content =
					!isFolder && file instanceof TFile
						? await this.obSync.app.vault.read(file)
						: null;

				await requestUrl({
					url: `${API_BASE_URL}/sync/create`,
					method: 'POST',
					headers: this.obSync.authHeaders(),
					body: JSON.stringify({
						path: file.path,
						isFolder,
						content,
					}),
				});
			}),
		);

		this.obSync.registerEvent(
			this.obSync.app.vault.on('delete', async (file) => {
				if (
					!this.obSync.canPublishGlobalChanges() ||
					this.obSync.isMuted(file.path)
				)
					return;

				const isFolder = file instanceof TFolder;
				this.obSync.disconnectCollabRoomIfAffected(file.path);

				await requestUrl({
					url: `${API_BASE_URL}/sync/delete`,
					method: 'DELETE',
					headers: this.obSync.authHeaders(),
					body: JSON.stringify({ path: file.path, isFolder }),
				});
			}),
		);

		this.obSync.registerEvent(
			this.obSync.app.vault.on('modify', async (file) => {
				if (
					!this.obSync.canPublishGlobalChanges() ||
					this.obSync.isMuted(file.path)
				)
					return;
				const activeFile = this.obSync.app.workspace.getActiveFile();
				// O Yjs cuida do arquivo ativo, então não disparamos o PUT para ele
				if (activeFile && file.path === activeFile.path) return;

				if (file instanceof TFile) {
					const content = await this.obSync.app.vault.read(file);
					await requestUrl({
						url: `${API_BASE_URL}/sync/modify`,
						method: 'PUT',
						headers: this.obSync.authHeaders(),
						body: JSON.stringify({ path: file.path, content }),
					});
				}
			}),
		);
		//TODO: fix bug for syncing folders with files inside, Tfolders are a bit more complex
		this.obSync.registerEvent(
			this.obSync.app.vault.on('rename', async (file, oldPath) => {
				if (
					!this.obSync.canPublishGlobalChanges() ||
					this.obSync.isMuted(file.path) ||
					this.obSync.isMuted(oldPath)
				) {
					return;
				}

				if (file instanceof TFolder) {
					this.obSync.isMuted(oldPath);
					this.obSync.isMuted(file.path);
				}
				await requestUrl({
					url: `${API_BASE_URL}/sync/rename`,
					method: 'PUT',
					headers: this.obSync.authHeaders(),
					body: JSON.stringify({ oldPath, newPath: file.path }),
				});

				if (
					this.obSync.currentCollabPath &&
					this.obSync.isSamePathOrChild(
						oldPath,
						this.obSync.currentCollabPath,
					)
				) {
					this.obSync.scheduleActiveCollabRoomSync();
				}
			}),
		);
	}
}
