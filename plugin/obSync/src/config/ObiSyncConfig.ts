import type { AuthenticatedUser } from '../auth/auth.types.ts';

export type ObiSyncConfig = {
	accessTokenExpiresAt: number;
	user: AuthenticatedUser | null;
};

export const DEFAULT_CONFIG: ObiSyncConfig = {
	accessTokenExpiresAt: 0,
	user: null,
};
