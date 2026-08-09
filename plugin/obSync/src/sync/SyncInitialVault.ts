import { requestUrl, Notice } from 'obsidian';
import ObSync from '../main.ts';
import { API_BASE_URL } from '../constants.ts';
import JSZip from 'jszip';
export type syncRead = {
	myFlag: boolean;
	name: string;
};

const payload: syncRead = {
	myFlag: true,
	name: 'obsidian ready to sync',
};

export class SyncInitialVault {
	private readonly obSync: ObSync;
	constructor(obSync: ObSync) {
		this.obSync = obSync;
	}
	public initialize() {
		this.initialSync();
	}
	private initialSync() {
		void (async () => {
			try {
				const response = await requestUrl({
					url: `${API_BASE_URL}/api/syncfiles`,
					method: 'POST',
					headers: this.obSync.authHeaders(),
					body: JSON.stringify(payload),
				});

				if (response.status !== 200) {
					throw new Error(
						`Servidor retornou erro: ${response.status}`,
					);
				}
				const zip = await JSZip.loadAsync(response.arrayBuffer);
				const adapter = this.obSync.app.vault.adapter;

				for (const caminhoRelativo of Object.keys(zip.files)) {
					const entradaZip = zip.files[caminhoRelativo];
					if (!entradaZip) continue;

					if (entradaZip.dir) {
						if (!(await adapter.exists(caminhoRelativo))) {
							this.obSync.mutePath(caminhoRelativo);
							await adapter.mkdir(caminhoRelativo);
						}
					} else {
						const conteudoBuffer =
							await entradaZip.async('arraybuffer');
						const pastaPai = caminhoRelativo.substring(
							0,
							caminhoRelativo.lastIndexOf('/'),
						);

						if (pastaPai && !(await adapter.exists(pastaPai))) {
							this.obSync.mutePath(pastaPai);
							await adapter.mkdir(pastaPai);
						}
						if (
							this.obSync.canPublishGlobalChanges() ||
							!(await adapter.exists(caminhoRelativo))
						) {
							this.obSync.mutePath(caminhoRelativo);
							await adapter.writeBinary(
								caminhoRelativo,
								conteudoBuffer,
							);
						}
					}
				}
				new Notice('Sincronização inicial concluída.');
			} catch (error) {
				console.error('Erro na sincronização inicial:', error);
				new Notice(
					'Não foi possível sincronizar os arquivos iniciais.',
				);
			}
		})();
	}
}
