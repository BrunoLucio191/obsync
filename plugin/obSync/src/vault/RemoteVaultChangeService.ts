import type { App } from 'obsidian';
import type { VaultChange } from './VaultChange.ts';
import type { AuthService } from '../auth/AuthService.ts';
import type { CollaborationController } from '../collab/CollaborationController.ts';
import { PathMuteRegistry } from './PathMuteRegistry.ts';

export class RemoteVaultChangeService {
	public constructor(
		private readonly app: App,
		private readonly auth: AuthService,
		private readonly mutedPaths: PathMuteRegistry,
		private readonly collaboration: CollaborationController,
	) {}

	public async apply(change: VaultChange): Promise<void> {
		const adapter = this.app.vault.adapter;

		if (change.type === 'create') {
			if (this.auth.isReadOnlyUser() && (await adapter.exists(change.path))) {
				return;
			}

			this.mutedPaths.mute(change.path);
			if (change.isFolder) {
				if (!(await adapter.exists(change.path))) {
					await adapter.mkdir(change.path);
				}
			} else {
				await this.ensureParentFolder(change.path);
				await adapter.write(change.path, change.content);
			}
			return;
		}

		if (change.type === 'modify') {
			if (this.auth.isReadOnlyUser() && (await adapter.exists(change.path))) {
				return;
			}

			this.mutedPaths.mute(change.path);
			await this.ensureParentFolder(change.path);
			await adapter.write(change.path, change.content);
			return;
		}

		if (change.type === 'delete') {
			this.collaboration.disconnectIfAffected(change.path);
			this.mutedPaths.mute(change.path);

			const file = this.app.vault.getAbstractFileByPath(change.path);
			if (file) {
				await this.app.fileManager.trashFile(file);
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

		this.mutedPaths.mute(change.oldPath);
		this.mutedPaths.mute(change.newPath);
		if (await adapter.exists(change.oldPath)) {
			await this.ensureParentFolder(change.newPath);
			await adapter.rename(change.oldPath, change.newPath);
		}
	}

	private async ensureParentFolder(filePath: string): Promise<void> {
		const parent = filePath.substring(0, filePath.lastIndexOf('/'));
		if (!parent) return;

		const adapter = this.app.vault.adapter;
		const parts = parent.split('/');
		let current = '';

		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await adapter.exists(current))) {
				this.mutedPaths.mute(current);
				await adapter.mkdir(current);
			}
		}
	}
}
