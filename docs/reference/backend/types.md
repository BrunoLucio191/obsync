# Backend data types

## Authentication

Source: [`backend/auth/auth.types.ts`](../../../backend/auth/auth.types.ts)

### `UserRole` and `AuthenticatedUser`

```ts
type UserRole = "admin" | "user";

type AuthenticatedUser = {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
  color: string;   // lowercase #rrggbb, the user's cursor color
};
```

### `AuthSession`

```ts
type AuthSession = {
  token: string;          // access token (JWT)
  refreshToken: string;   // "<session id>.<random>"
  expiresIn: number;      // seconds
  user: AuthenticatedUser;
};
```

### `TokenPayload`

```ts
type TokenPayload = {
  iss: "obsync";
  aud: "obsync-api";
  sub: string;   // user id
  sid: string;   // session id
  jti: string;   // random token id
  iat: number;   // Unix seconds
  nbf: number;
  exp: number;
};
```

### WebSocket credentials

```ts
type WebSocketChannel = "system" | "yjs";

type WebSocketTicket = {
  ticket: string;
  expiresIn: number;   // seconds
};
```

Internal types in
[`backend/auth/tokenService.types.ts`](../../../backend/auth/tokenService.types.ts):

```ts
type SessionRecord = {
  readonly userId: number;
  refreshTokenHash: string;         // HMAC of the current refresh token
  readonly refreshExpiresAt: number; // Unix milliseconds
};

type AccessAuthorization = {
  readonly user: AuthenticatedUser;  // reloaded from SQLite
  readonly sessionId: string;
  readonly expiresAt: number;        // access token expiry, Unix milliseconds
};

type WebSocketTicketRecord = AccessAuthorization & {
  readonly channel: WebSocketChannel;
  readonly ticketExpiresAt: number;
};

type WebSocketAuthorization = AccessAuthorization;
```

`expiresAt` is in milliseconds because it feeds a server timer directly.

## User mutation results

```ts
type CreateUserResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: "email_exists" | "name_exists" };

type UserMutationResult =
  | { ok: true; user: AuthenticatedUser }
  | {
      ok: false;
      reason: "NOT_FOUND" | "LAST_ADMIN" | "INVALID_ROLE" | "NAME_EXISTS" | "INVALID_CURRENT_PASSWORD";
    };
```

The two result types use different casing for their reasons.
`userMutationErrorStatus()` and `UserMutationErrorMessage()` in
`routes/mutationMessage/userMessageMutation.ts` map `UserMutationResult`
reasons to `404`, `409`, `400`, `409` and `401` respectively.

## VaultChange

Source: [`backend/syncEvents.ts`](../../../backend/syncEvents.ts)

```ts
type VaultChange =
  | { type: "create"; path: string; isFolder: boolean; content?: string; isBinary?: boolean; originClientId?: string }
  | { type: "delete"; path: string; isFolder: boolean; originClientId?: string }
  | { type: "modify"; path: string; content: string; originClientId?: string }
  | { type: "rename"; oldPath: string; newPath: string; isFolder: boolean; originClientId?: string };
```

`publishVaultChange(change)` emits it on `vaultEvents`; `WebSocketServer`
forwards it to `/system`. The plugin has its own copy of this type in
`plugin/obSync/src/vault/VaultChange.ts`, which must be kept in sync by hand.

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

Source: [`backend/yjs/yjs.types.ts`](../../../backend/yjs/yjs.types.ts)

```ts
type YjsAuthenticatedConnection = {   // built by WebSocketServer from the ticket
  readonly userId: number;
  readonly userName: string;
  readonly userEmail: string;
  readonly userRole: "admin" | "user";
};

type YjsConnectionState = {           // one per socket, stored in room.connections
  readonly controlledAwarenessIds: Set<number>;  // awareness client ids this socket owns
  readonly authenticatedPresenceId: string;      // normalized e-mail
  readonly userId: number;
  readonly userRole: "admin" | "user";
  readonly canWriteGlobal: boolean;              // userRole === "admin"
  closed: boolean;
};

type YjsPersistenceAdapter = {
  bindState(docName: string, ydoc: Y.Doc): Promise<void>;
  writeState(docName: string, ydoc: Y.Doc): Promise<void>;
  destroyState?(docName: string, ydoc: Y.Doc): Promise<void> | void;
  deleteStateUnderPath?(targetPath: string): Promise<void>;
  renameStatePath?(oldPath: string, newPath: string): Promise<void>;
};

type YjsDocumentIdentity = {
  readonly docName: string;    // URI-encoded normalized path, the registry key
  readonly filePath: string;   // normalized vault path
};
```
