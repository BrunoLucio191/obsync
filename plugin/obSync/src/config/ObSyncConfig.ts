import type { AuthenticatedUser } from '../auth/auth.types.ts';

/** Shape of the plugin's persisted settings, saved/loaded via Obsidian's `loadData`/`saveData`. */
export type ObSyncConfig = {
	backendUrl: string;
	accessTokenExpiresAt: number;
	user: AuthenticatedUser | null;
};

/** Initial config used before anything has been saved, or when a saved field is missing. */
export const DEFAULT_CONFIG: ObSyncConfig = {
	backendUrl: '',
	accessTokenExpiresAt: 0,
	user: null,
};
