import { ZipWorkerSon } from './zipWorker/ZipWorkerSon.ts';

export class Boss {
	readonly #zipWorkerSon: ZipWorkerSon;

	constructor(zipWorkerSon: ZipWorkerSon) {
		this.#zipWorkerSon = zipWorkerSon;
	}

	public async startWorking(): Promise<void> {
		await this.#zipWorkerSon.startWorking();
	}
}
