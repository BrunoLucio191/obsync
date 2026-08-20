export type AuthSession = {
	token: string;
	refreshToken: string;
	expiresIn: number;
	user: AuthenticatedUser;
};

export type WebSocketChannel = 'system' | 'yjs';

export type WebSocketTicket = {
	ticket: string;
	expiresIn: number;
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
