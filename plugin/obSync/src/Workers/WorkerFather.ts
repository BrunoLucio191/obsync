import { App, Notice } from 'obsidian';
import { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';
import { ZipWorkerSon } from './zipWorkerSon.ts';
import { AuthService } from '../auth/AuthService.ts';
import { error } from 'lib0';
import { t } from '../i18n/i18n.ts';

export class WorkerFather {
	private zipWokerSon!: Worker;
	private zipSonTimeToWork!: ZipWorkerSon;
	constructor(
		private readonly app: App,
		private readonly mutedPath: PathMuteRegistry,
		private readonly auth: AuthService,
	) {}
	public startWorking() {
		this.zipWokerSon = new Worker('../Workers/zipWorkerSon.tsrkerSon.ts');
		this.zipSonTimeToWork = new ZipWorkerSon(this.app, this.mutedPath, this.auth);
		this.zipSonTimeToWork.working();
		this.makeZipSonWork();
	}
	private makeZipSonWork() {
		this.zipWokerSon.onmessage = <T>(message: T) => {
			if (message instanceof Error) {
				console.error(t('sync.initialSyncError'), error);
				new Notice(t('sync.initialSyncFailed'));
			}
			if (message === 'success') {
				new Notice(t('sync.initialSyncComplete'));
			}
		};
	}
}
