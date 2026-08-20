import type { ObiSyncConfig } from '../config/ObiSyncConfig.ts';
import type {
	AuthenticatedUser,
	UserActionResult,
	UserRole,
} from '../auth/auth.types.ts';

export interface SettingsController {
	readonly config: ObiSyncConfig;
	openLogin(): Promise<boolean>;
	logout(): Promise<void>;
	listUsers(): Promise<UserActionResult<AuthenticatedUser[]>>;
	createUser(input: {
		name: string;
		email: string;
		password: string;
		role: UserRole;
	}): Promise<UserActionResult<AuthenticatedUser>>;
	updateUserName(
		userId: number,
		name: string,
	): Promise<UserActionResult<AuthenticatedUser>>;
	updateUserRole(
		userId: number,
		role: UserRole,
	): Promise<UserActionResult<AuthenticatedUser>>;
	updateUserStatus(
		userId: number,
		active: boolean,
	): Promise<UserActionResult<AuthenticatedUser>>;
	deleteUser(userId: number): Promise<UserActionResult<AuthenticatedUser>>;
}
