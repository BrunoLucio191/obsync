import type { AuthenticatedUser } from '../auth/auth.types.ts';

export type ObSyncConfig = {
	accessTokenExpiresAt: number;
	user: AuthenticatedUser | null;
};

export const DEFAULT_CONFIG: ObSyncConfig = {
	accessTokenExpiresAt: 0,
	user: null,
};
