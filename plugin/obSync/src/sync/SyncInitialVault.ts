import { requestUrl, Notice } from 'obsidian';
import { API_BASE_URL } from '../config/ApiConfig.ts';
import JSZip from 'jszip';
import type { App } from 'obsidian';
import type { AuthService } from '../auth/AuthService.ts';
import type { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';

const payload = {
	myFlag: true,
	name: 'obsidian ready to sync',
};

export class SyncInitialVault {
	public constructor(
		private readonly app: App,
		private readonly auth: AuthService,
		private readonly mutedPaths: PathMuteRegistry,
	) {}

	public async sync(): Promise<void> {
		try {
			const response = await requestUrl({
				url: `${API_BASE_URL}/api/syncfiles`,
				method: 'POST',
				headers: this.auth.headers(),
				body: JSON.stringify(payload),
			});

			if (response.status !== 200) {
				throw new Error(`Servidor retornou erro: ${response.status}`);
			}
			const zip = await JSZip.loadAsync(response.arrayBuffer);
			const adapter = this.app.vault.adapter;

			for (const relativePath of Object.keys(zip.files)) {
				const entry = zip.files[relativePath];
				if (!entry) continue;

				if (entry.dir) {
					if (!(await adapter.exists(relativePath))) {
						this.mutedPaths.mute(relativePath);
						await adapter.mkdir(relativePath);
					}
				} else {
					const content = await entry.async('arraybuffer');
					const parentPath = relativePath.substring(
						0,
						relativePath.lastIndexOf('/'),
					);

					if (parentPath && !(await adapter.exists(parentPath))) {
						this.mutedPaths.mute(parentPath);
						await adapter.mkdir(parentPath);
					}
					if (
						this.auth.isAdmin() ||
						!(await adapter.exists(relativePath))
					) {
						this.mutedPaths.mute(relativePath);
						await adapter.writeBinary(relativePath, content);
					}
				}
			}
			new Notice('Sincronização inicial concluída.');
		} catch (error) {
			console.error('Erro na sincronização inicial:', error);
			new Notice('Não foi possível sincronizar os arquivos iniciais.');
		}
	}
}
