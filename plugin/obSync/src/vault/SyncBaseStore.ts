import type { DataAdapter } from 'obsidian';

type BaseEntry = { hash: string; text: boolean };

/**
 * The last server version of each file a regular user received (the merge base):
 * an index of path -> hash, plus text versions stored by hash.
 */
export class SyncBaseStore {
	readonly #adapter: DataAdapter;
	readonly #dir: string;
	#index: Record<string, BaseEntry> | null = null;

	public constructor(adapter: DataAdapter, dir: string) {
		this.#adapter = adapter;
		this.#dir = dir;
	}
	//creates a hash for file identification:
	public static async hash(data: ArrayBuffer | string): Promise<string> {
		const bytes =
			typeof data === 'string'
				? new TextEncoder().encode(data)
				: new Uint8Array(data);
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		return [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
	}

	public async getHash(path: string): Promise<string | null> {
		const index = await this.#load();
		const entry = index[path];
		return entry?.hash ?? null;
	}

	public async getText(path: string): Promise<string | null> {
		const index = await this.#load();
		const entry = index[path];
		if (!entry?.text) return null;

		const file = this.#textFile(entry.hash);
		return (await this.#adapter.exists(file))
			? this.#adapter.read(file)
			: null;
	}

	public async setText(path: string, text: string): Promise<void> {
		const hash = await SyncBaseStore.hash(text);
		const file = this.#textFile(hash);
		if (!(await this.#adapter.exists(file))) {
			await this.#ensureDir();
			await this.#adapter.write(file, text);
		}
		await this.#put(path, { hash, text: true });
	}

	public async setBinary(path: string, hash: string): Promise<void> {
		await this.#put(path, { hash, text: false });
	}

	public async rename(oldPath: string, newPath: string): Promise<void> {
		const index = await this.#load();
		let changed = false;
		for (const path of Object.keys(index)) {
			if (path !== oldPath && !path.startsWith(`${oldPath}/`)) {
				continue;
			}
			index[newPath + path.slice(oldPath.length)] = index[path]!;
			delete index[path];
			changed = true;
		}
		if (changed) await this.#save();
	}

	public async forget(path: string): Promise<void> {
		const index = await this.#load();
		const removedPaths = Object.keys(index).filter(
			(indexedPath) =>
				indexedPath === path || indexedPath.startsWith(`${path}/`),
		);
		if (!removedPaths.length) return;
		const removedEntries = removedPaths.map((p) => index[p]!);
		for (const p of removedPaths) {
			delete index[p];
		}
		await this.#save();
		for (const entry of removedEntries) {
			await this.#releaseText(entry);
		}
	}

	async #put(path: string, entry: BaseEntry): Promise<void> {
		const index = await this.#load();
		const previous = index[path];
		index[path] = entry;
		await this.#save();
		if (previous && previous.hash !== entry.hash) {
			await this.#releaseText(previous);
		}
	}

	async #releaseText(entry: BaseEntry): Promise<void> {
		if (!entry.text) return;
		const index = await this.#load();
		if (
			Object.values(index).some(
				(other) => other.text && other.hash === entry.hash,
			)
		) {
			return;
		}
		const file = this.#textFile(entry.hash);
		if (await this.#adapter.exists(file)) {
			await this.#adapter.remove(file);
		}
	}

	async #load(): Promise<Record<string, BaseEntry>> {
		if (this.#index) return this.#index;
		const file = `${this.#dir}/index.json`;
		this.#index = (await this.#adapter.exists(file))
			? (JSON.parse(await this.#adapter.read(file)) as Record<
					string,
					BaseEntry
				>)
			: {};
		return this.#index;
	}

	async #save(): Promise<void> {
		await this.#ensureDir();
		await this.#adapter.write(
			`${this.#dir}/index.json`,
			JSON.stringify(this.#index),
		);
	}

	async #ensureDir(): Promise<void> {
		if (!(await this.#adapter.exists(this.#dir))) {
			await this.#adapter.mkdir(this.#dir);
		}
	}

	#textFile(hash: string): string {
		return `${this.#dir}/${hash}.txt`;
	}
}
