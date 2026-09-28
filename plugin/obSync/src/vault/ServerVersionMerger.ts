import { Notice, type App } from 'obsidian';
import { merge } from 'node-diff3';
import { t } from '../i18n/i18n.ts';
import { isBinaryPath } from './binaryExtensions.ts';
import { ensureParentFolder } from './ensureParentFolder.ts';
import type { PathMuteRegistry } from './PathMuteRegistry.ts';
import { SyncBaseStore } from './SyncBaseStore.ts';

/**
 * Applies a server version of a file to a regular user's vault without losing
 * their private edits.
 */
export class ServerVersionMerger {
	readonly #app: App;
	readonly #mutedPaths: PathMuteRegistry;
	readonly #store: SyncBaseStore;

	public constructor(
		app: App,
		mutedPaths: PathMuteRegistry,
		store: SyncBaseStore,
	) {
		this.#app = app;
		this.#mutedPaths = mutedPaths;
		this.#store = store;
	}

	public async apply(
		path: string,
		data: ArrayBuffer | string,
	): Promise<void> {
		if (isBinaryPath(path)) {
			await this.#applyBinary(
				path,
				typeof data === 'string'
					? new TextEncoder().encode(data).buffer
					: data,
			);
		} else {
			await this.#applyText(
				path,
				typeof data === 'string'
					? data
					: new TextDecoder().decode(data),
			);
		}
	}

	/**
	 * Where the user moved `oldPath` without editing it: a file with the same name and
	 * content as its base. Files with a base of their own are synced files, not that copy.
	 */
	public async findMovedCopy(oldPath: string): Promise<string | null> {
		const baseHash = await this.#store.getHash(oldPath);
		if (!baseHash) return null;

		const adapter = this.#app.vault.adapter;
		const name = oldPath.slice(oldPath.lastIndexOf('/') + 1);
		for (const file of this.#app.vault.getFiles()) {
			if (file.name !== name || (await this.#store.getHash(file.path)))
				continue;
			const content = isBinaryPath(file.path)
				? await adapter.readBinary(file.path)
				: await adapter.read(file.path);
			if ((await SyncBaseStore.hash(content)) === baseHash)
				return file.path;
		}
		return null;
	}

	public rename(oldPath: string, newPath: string): Promise<void> {
		return this.#store.rename(oldPath, newPath);
	}

	public forget(path: string): Promise<void> {
		return this.#store.forget(path);
	}

	async #applyText(path: string, incoming: string): Promise<void> {
		const adapter = this.#app.vault.adapter;
		const local = (await adapter.exists(path))
			? await adapter.read(path)
			: null;
		const base = await this.#store.getText(path);

		if (local === null || local === incoming || local === base) {
			if (local !== incoming) await this.#write(path, incoming);
		} else if (base === null) {
			return;
		} else {
			const merged = merge(
				local.split('\n'),
				base.split('\n'),
				incoming.split('\n'),
				{
					label: {
						a: t('sync.yourVersion'),
						b: t('sync.serverVersion'),
					},
				},
			);
			await this.#write(path, merged.result.join('\n'));
			if (merged.conflict) new Notice(t('sync.mergeConflict', { path }));
		}
		await this.#store.setText(path, incoming);
	}

	async #applyBinary(path: string, incoming: ArrayBuffer): Promise<void> {
		const adapter = this.#app.vault.adapter;
		const incomingHash = await SyncBaseStore.hash(incoming);
		const localHash = (await adapter.exists(path))
			? await SyncBaseStore.hash(await adapter.readBinary(path))
			: null;
		const base = await this.#store.getHash(path);

		if (
			localHash === null ||
			localHash === incomingHash ||
			localHash === base
		) {
			if (localHash !== incomingHash)
				await this.#writeBinary(path, incoming);
		} else {
			const copy = serverCopyPath(path);
			await this.#writeBinary(copy, incoming);
			new Notice(t('sync.binaryConflict', { path, copy }));
		}
		await this.#store.setBinary(path, incomingHash);
	}

	async #write(path: string, content: string): Promise<void> {
		this.#mutedPaths.mute(path);
		await ensureParentFolder(
			this.#app.vault.adapter,
			this.#mutedPaths,
			path,
		);
		await this.#app.vault.adapter.write(path, content);
	}

	async #writeBinary(path: string, content: ArrayBuffer): Promise<void> {
		this.#mutedPaths.mute(path);
		await ensureParentFolder(
			this.#app.vault.adapter,
			this.#mutedPaths,
			path,
		);
		await this.#app.vault.adapter.writeBinary(path, content);
	}
}

/** `folder/name.ext` -> `folder/name (server version).ext` */
function serverCopyPath(path: string): string {
	const slash = path.lastIndexOf('/');
	const dot = path.lastIndexOf('.');
	const suffix = ` (${t('sync.serverVersion')})`;
	return dot > slash + 1
		? `${path.slice(0, dot)}${suffix}${path.slice(dot)}`
		: `${path}${suffix}`;
}
