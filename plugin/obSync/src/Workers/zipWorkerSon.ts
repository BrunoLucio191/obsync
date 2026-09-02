import { requestUrl } from 'obsidian';
import { getApiBaseUrl } from '../config/ApiConfig.ts';
import { App } from 'obsidian';
import { AuthService } from '../auth/AuthService.ts';
import JSZip from 'jszip';
import { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';
import { t } from '../i18n/i18n.ts';

export class ZipWorkerSon {
	constructor(
		private readonly app: App,
		private readonly mutedPaths: PathMuteRegistry,
		private readonly auth: AuthService,
	) {}

	public working() {
		self.onmessage = async () => {
			try {
				if (!(await this.auth.prepareAuthenticatedRequest())) {
					throw new Error(t('sync.invalidOrExpiredSession'));
				}

				const response = await requestUrl({
					url: `${getApiBaseUrl()}/api/syncfiles`,
					method: 'POST',
					headers: this.auth.headers(),
				});
				if (response.status != 200) {
					throw new Error(t('sync.serverReturnedError', { status: response.status }));
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
						const parentPath = relativePath.substring(0, relativePath.lastIndexOf('/'));

						if (parentPath && !(await adapter.exists(parentPath))) {
							this.mutedPaths.mute(relativePath);
							await adapter.mkdir(relativePath);
						}
						//TODO: fix implementation for non admin deals with files that has changed;
						if (this.auth.isAdmin() || !(await adapter.exists(relativePath))) {
							this.mutedPaths.mute(relativePath);
							await adapter.writeBinary(relativePath, content);
						}
					}
				}
				postMessage('success');
			} catch (error) {
				//send work error to the father
				const workError = error;
				postMessage(workError);
			}
		};
	}
}
