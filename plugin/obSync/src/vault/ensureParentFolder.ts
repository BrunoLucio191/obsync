import type { DataAdapter } from 'obsidian';
import type { PathMuteRegistry } from './PathMuteRegistry.ts';

/** Creates the missing parent folders of a file, muting each so its event isn't republished. */
export async function ensureParentFolder(
	adapter: DataAdapter,
	mutedPaths: PathMuteRegistry,
	filePath: string,
): Promise<void> {
	const parent = filePath.substring(0, filePath.lastIndexOf('/'));
	if (!parent) return;

	let current = '';
	for (const part of parent.split('/')) {
		current = current ? `${current}/${part}` : part;
		if (!(await adapter.exists(current))) {
			mutedPaths.mute(current);
			await adapter.mkdir(current);
		}
	}
}
