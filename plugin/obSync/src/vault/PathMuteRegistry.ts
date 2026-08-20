export class PathMuteRegistry {
	private readonly mutedPaths = new Map<string, number>();

	public constructor(private readonly muteDurationMs = 2_000) {}

	public mute(path: string): void {
		this.mutedPaths.set(path, Date.now() + this.muteDurationMs);
	}

	public isMuted(path: string): boolean {
		this.removeExpiredEntries();

		for (const mutedPath of this.mutedPaths.keys()) {
			if (PathMuteRegistry.contains(mutedPath, path)) return true;
		}

		return false;
	}

	public clear(): void {
		this.mutedPaths.clear();
	}

	public static contains(rootPath: string, candidatePath: string): boolean {
		return (
			candidatePath === rootPath ||
			candidatePath.startsWith(`${rootPath}/`)
		);
	}

	private removeExpiredEntries(): void {
		const now = Date.now();
		for (const [path, expiresAt] of this.mutedPaths) {
			if (expiresAt < now) this.mutedPaths.delete(path);
		}
	}
}
