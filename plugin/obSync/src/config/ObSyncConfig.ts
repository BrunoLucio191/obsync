import type { AuthenticatedUser } from '../auth/auth.types.ts';

export type ObSyncConfig = {
	backendUrl: string;
	accessTokenExpiresAt: number;
	user: AuthenticatedUser | null;
};

export const DEFAULT_CONFIG: ObSyncConfig = {
	backendUrl: '',
	accessTokenExpiresAt: 0,
	user: null,
};
