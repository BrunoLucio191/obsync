import JSZip from 'jszip';

export type ZipWorkerEntry =
	| { path: string; isDir: true }
	| { path: string; isDir: false; content: ArrayBuffer };

export type ZipWorkerMessage =
	| { status: 'success'; entries: ZipWorkerEntry[] }
	| { status: 'error'; message: string };

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
	try {
		const zip = await JSZip.loadAsync(event.data);
		const entries: ZipWorkerEntry[] = [];
		const transferables: ArrayBuffer[] = [];

		for (const relativePath of Object.keys(zip.files)) {
			const entry = zip.files[relativePath];
			if (!entry) continue;

			if (entry.dir) {
				entries.push({ path: relativePath, isDir: true });
			} else {
				const content = await entry.async('arraybuffer');
				entries.push({ path: relativePath, isDir: false, content });
				transferables.push(content);
			}
		}
		postMessage({ status: 'success', entries } satisfies ZipWorkerMessage, {
			transfer: transferables,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		postMessage({ status: 'error', message } satisfies ZipWorkerMessage);
	}
};
