import JSZip from 'jszip';

export type ZipWorkerEntry =
	| { path: string; isDir: true }
	| { path: string; isDir: false; content: ArrayBuffer; ext: string };

export type ZipWorkerMessage =
	| { status: 'success'; entries: ZipWorkerEntry[] }
	| { status: 'error'; message: string };

/**
 * Runs inside a real Worker thread (spawned by ZipWorkerSon), so it has zero
 * access to the Obsidian API — no `app`, no `require('obsidian')`. It only
 * unzips the bytes it's given and hands the extracted entries back; the main
 * thread is the one that decides what to do with each entry in the vault.
 */
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
				const fileExtension = relativePath.slice(
					relativePath.lastIndexOf('.'),
					relativePath.length,
				);

				entries.push({ path: relativePath, isDir: false, content, ext: fileExtension });
				transferables.push(content);
			}
		}
		window.postMessage({ status: 'success', entries } satisfies ZipWorkerMessage, {
			transfer: transferables,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		window.postMessage({ status: 'error', message } satisfies ZipWorkerMessage);
	}
};
