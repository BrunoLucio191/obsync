import type { AuthenticatedUser } from '../auth/auth.types.ts';

export type ObiSyncConfig = {
	token: string;
	user: AuthenticatedUser | null;
};

export const DEFAULT_CONFIG: ObiSyncConfig = {
	token: '',
	user: null,
};
