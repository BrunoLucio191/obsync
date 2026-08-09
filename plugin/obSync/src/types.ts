export type File = {
	file: string;
	name: string;
	path: string;
};
export type AuthSession = {
	token: string;
	user: AuthenticatedUser;
};

export type UserRole = 'admin' | 'user';

export type AuthenticatedUser = {
	id: number;
	email: string;
	name: string;
	role: UserRole;
	active: boolean;
};

export type UserActionResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };
