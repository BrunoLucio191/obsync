import { ZipWorkerSon } from './zipWorker/ZipWorkerSon.ts';

export class Boss {
	constructor(private readonly zipWorkerSon: ZipWorkerSon) {}

	public async startWorking(): Promise<void> {
		await this.zipWorkerSon.startWorking();
	}
}
