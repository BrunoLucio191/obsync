/**
 * Paths the plugin itself is about to change, so the resulting vault event isn't
 * published back to the server. Mutes expire on their own.
 */
export class PathMuteRegistry {
	readonly #mutedPaths = new Map<string, number>();
	readonly #muteDurationMs: number;

	constructor(muteDurationMs = 2_000) {
		this.#muteDurationMs = muteDurationMs;
	}
	public mute(path: string): void {
		this.#mutedPaths.set(path, Date.now() + this.#muteDurationMs);
	}

	/** A muted folder mutes everything under it. */
	public isMuted(path: string): boolean {
		this.#removeExpiredEntries();

		for (const mutedPath of this.#mutedPaths.keys()) {
			if (PathMuteRegistry.contains(mutedPath, path)) return true;
		}

		return false;
	}

	public clear(): void {
		this.#mutedPaths.clear();
	}

	public static contains(rootPath: string, candidatePath: string): boolean {
		return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
	}

	#removeExpiredEntries(): void {
		const now = Date.now();
		for (const [path, expiresAt] of this.#mutedPaths) {
			if (expiresAt < now) this.#mutedPaths.delete(path);
		}
	}
}
