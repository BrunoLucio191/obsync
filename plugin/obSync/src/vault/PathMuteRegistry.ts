/**
 * Temporarily "mutes" vault paths that are about to be changed programmatically
 * (e.g. writing a file received from a remote sync event), so the resulting
 * local vault event isn't mistaken for a user-initiated change and re-published
 * back to the server. Mutes expire automatically after a short duration.
 */
export class PathMuteRegistry {
	readonly #mutedPaths = new Map<string, number>();
	readonly #muteDurationMs: number;

	constructor(muteDurationMs = 2_000) {
		this.#muteDurationMs = muteDurationMs;
	}
	/**
	 * Marks a path as muted for {@link #muteDurationMs}.
	 * @param path - Vault-relative path to mute.
	 */
	public mute(path: string): void {
		this.#mutedPaths.set(path, Date.now() + this.#muteDurationMs);
	}

	/**
	 * Checks whether a path is currently muted, either directly or because it
	 * falls under a muted ancestor folder.
	 * @param path - Vault-relative path to check.
	 * @returns `true` if the path (or an ancestor of it) is muted and not yet expired.
	 */
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

	/**
	 * Determines whether `candidatePath` is `rootPath` itself or nested inside it.
	 * @param rootPath - The potential ancestor (or exact) path.
	 * @param candidatePath - The path being tested for containment.
	 * @returns `true` if `candidatePath` equals `rootPath` or is a descendant of it.
	 */
	public static contains(rootPath: string, candidatePath: string): boolean {
		return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
	}

	/** Purges muted paths whose expiry timestamp has passed. */
	#removeExpiredEntries(): void {
		const now = Date.now();
		for (const [path, expiresAt] of this.#mutedPaths) {
			if (expiresAt < now) this.#mutedPaths.delete(path);
		}
	}
}
