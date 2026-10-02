import JSZip from 'jszip';

export type ZipWorkerEntry =
	| { path: string; isDir: true }
	| { path: string; isDir: false; content: ArrayBuffer; ext: string };

export type ZipWorkerMessage =
	| { status: 'success'; entries: ZipWorkerEntry[] }
	| { status: 'error'; message: string };

/** A real Worker has no Obsidian API, so it only unzips; the main thread writes the vault. */
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

				entries.push({
					path: relativePath,
					isDir: false,
					content,
					ext: fileExtension,
				});
				transferables.push(content);
			}
		}
		self.postMessage(
			{ status: 'success', entries } satisfies ZipWorkerMessage,
			{
				transfer: transferables,
			},
		);
	} catch (error) {
		error.toString();
		const message =
			error instanceof Error ? error.message : error.toString();
		self.postMessage({
			status: 'error',
			message,
		} satisfies ZipWorkerMessage);
	}
};
