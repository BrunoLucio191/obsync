# Backend data types

## Authentication

Source: [`backend/auth/auth.types.ts`](../../../backend/auth/auth.types.ts)

### `UserRole` and `AuthenticatedUser`

```ts
type UserRole = 'admin' | 'user';

type AuthenticatedUser = {
	id: number;
	email: string;
	name: string;
	role: UserRole;
	active: boolean;
};
```

### `AuthSession`

```ts
type AuthSession = {
	token: string;
	refreshToken: string;
	expiresIn: number;
	user: AuthenticatedUser;
};
```

### `TokenPayload`

```ts
type TokenPayload = {
	iss: 'obsync';
	aud: 'obsync-api';
	sub: string;
	sid: string;
	jti: string;
	iat: number;
	nbf: number;
	exp: number;
};
```

Times in the signed payload use Unix seconds. `sub` is the user ID and `sid`
links the access token to a revocable in-memory session.

### WebSocket credentials

`WebSocketChannel` lives in `auth.types.ts`; `WebSocketAuthorization` and the
other `TokenService` internals live in
[`backend/auth/tokenService.types.ts`](../../../backend/auth/tokenService.types.ts).

```ts
type WebSocketChannel = 'system' | 'yjs';

type WebSocketTicket = {
	ticket: string;
	expiresIn: number;
};

type WebSocketAuthorization = {
	user: AuthenticatedUser;
	sessionId: string;
	expiresAt: number;
};
```

`expiresAt` uses Unix milliseconds because it is passed directly to a server
timer.

## User mutation results

```ts
type CreateUserResult =
	| { ok: true; user: AuthenticatedUser }
	| { ok: false; reason: 'email_exists' | 'name_exists' };
```

```ts
type UserMutationResult =
	| { ok: true; user: AuthenticatedUser }
	| {
			ok: false;
			reason:
				| 'not_found'
				| 'last_admin'
				| 'invalid_role'
				| 'name_exists';
	  };
```

`ExpressServer` maps these domain reasons to HTTP status codes and messages.

## VaultChange

Source: [`backend/syncEvents.ts`](../../../backend/syncEvents.ts)

```ts
type VaultChange =
	| { type: 'create'; path: string; isFolder: boolean; content: string }
	| { type: 'modify'; path: string; content: string }
	| { type: 'delete'; path: string; isFolder: boolean }
	| { type: 'rename'; oldPath: string; newPath: string };
```

Every variant may include `originClientId` for client-side echo suppression.

## ServerConfig

Source: [`backend/serverConfig.ts`](../../../backend/serverConfig.ts)

```ts
type ServerConfig = {
	host: string;
	port: number;
	requireTls: boolean;
	trustProxy: boolean;
	tokenSecret: string;
};
```

## Yjs connection objects

Source: [`backend/yjsUtils.ts`](../../../backend/yjsUtils.ts)

```ts
type YjsAuthenticatedConnection = {
	userId: number;
	userName: string;
	userEmail: string;
	userRole: 'admin' | 'user';
};
```

The setup function converts this authenticated context into the internal
connection state used by sync and awareness validation.
