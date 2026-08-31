# Plugin settings API

`ObSync` implements the `SettingsController` interface itself and hands
`this` to `ObSyncSettingTab`, so every section below talks to the plugin
through that interface rather than holding a direct reference to `ObSync`.

Source: [`plugin/obSync/src/settings`](../../../plugin/obSync/src/settings/)

## `SettingsController`

```ts
interface SettingsController {
	readonly config: ObSyncConfig;
	setBackendUrl(url: string): Promise<UserActionResult<null>>;
	isAuthenticated(): boolean;
	openLogin(): Promise<boolean>;
	logout(): Promise<void>;
	listUsers(): Promise<UserActionResult<AuthenticatedUser[]>>;
	createUser(input: {
		name: string;
		email: string;
		password: string;
		role: UserRole;
	}): Promise<UserActionResult<AuthenticatedUser>>;
	updateUserName(userId: number, name: string): Promise<UserActionResult<AuthenticatedUser>>;
	updateUserRole(userId: number, role: UserRole): Promise<UserActionResult<AuthenticatedUser>>;
	updateUserStatus(userId: number, active: boolean): Promise<UserActionResult<AuthenticatedUser>>;
	deleteUser(userId: number): Promise<UserActionResult<AuthenticatedUser>>;
	resetUserPassword(userId: number, newPassword: string): Promise<UserActionResult<AuthenticatedUser>>;
	changePassword(currentPassword: string, newPassword: string): Promise<UserActionResult<null>>;
}
```

Every settings class below takes a `SettingsController` as a constructor
dependency instead of the concrete `ObSync` class. That keeps the settings UI
testable against a fake controller and keeps `ObSync` itself free of any
knowledge of how its methods are rendered.

## `ObSyncSettingTab`

```ts
new ObSyncSettingTab(app: App, plugin: Plugin, controller: SettingsController)
```

Source: [`ObSyncSettingTab.ts`](../../../plugin/obSync/src/settings/ObSyncSettingTab.ts)

Extends Obsidian's `PluginSettingTab` and owns the three section instances
below (`BackendConnectionSection`, `AccountSettingsSection`,
`UserManagementSection`), each constructed once in `ObSyncSettingTab`'s own
constructor and reused across re-renders. `getSettingDefinitions()` decides
which sections are visible for the current state, in order:

| State | Definitions returned |
| --- | --- |
| No backend URL configured | Just the backend field, so there's something to point a login attempt at |
| Backend configured, no session | Backend field, plus a single "Sign in" button |
| Signed in as `user` | Backend field, plus the account section |
| Signed in as `admin` | Backend field, account section, plus the full user-management section |

`hide()` calls `UserManagementSection.destroy()` so its list stops polling
and any pending debounced name-save timers are cleared when the settings tab
closes.

## `BackendConnectionSection`

Source: [`BackendConnectionSection.ts`](../../../plugin/obSync/src/settings/BackendConnectionSection.ts)

Renders the **Backend server URL** field that every other section depends on.
The field was originally role-gated after sign-in (editable pre-setup, then
admin-only), but that gate is currently disabled: `canEdit` is hardcoded to
`true`, so the field stays editable for every signed-in role, not just admins.
The original role-check logic was removed rather than left as a comment; only
the dead `canEdit` variable remains. Saving calls
`SettingsController.setBackendUrl()` and shows its `UserActionResult` error
inline through a `Notice` on failure.

## `AccountSettingsSection`

Source: [`AccountSettingsSection.ts`](../../../plugin/obSync/src/settings/AccountSettingsSection.ts)

Renders the signed-in account's own settings: connected e-mail and role,
an editable display name (admins edit it inline here through
`UserManagementSection.renderEditableName()`; regular users only see it,
since only admins can rename themselves without going through another
admin), a private-mode notice shown only to `user` accounts, a change-password
form that calls `SettingsController.changePassword()`, and a sign-out button.

## `UserManagementSection`

Source: [`UserManagementSection.ts`](../../../plugin/obSync/src/settings/UserManagementSection.ts)

Admin-only. Composes the four classes in `settings/users/` below behind a
single `definitions()` method that `ObSyncSettingTab` appends to the rest of
the page. It owns the one shared `UserDirectory` instance and passes it into
`UserListSection`, `UserNameEditor`, and `CreateUserSection`, so all three
always agree on the current in-memory list of users.

### `UserDirectory`

Source: [`users/UserDirectory.ts`](../../../plugin/obSync/src/settings/users/UserDirectory.ts)

The in-memory cache of users the settings UI renders from, kept sorted by
`id`. It never talks to the backend itself: `UserListSection` populates it
from `listUsers()` and every mutation below updates it locally so the list
reflects the change immediately instead of waiting on a full reload:

| Method | Effect |
| --- | --- |
| `replaceAll(users)` | Replaces the whole cache, sorted by `id` (used after the initial load) |
| `add(user)` | Inserts a newly created user at its sorted position; a no-op if that `id` is already cached |
| `replace(user)` | Updates one cached user in place, by `id` |
| `remove(userId)` | Drops one cached user, by `id` |
| `search(query)` | Returns users whose name or e-mail matches, accent-insensitively |
| `findByName(name, exceptUserId?)` | Finds a case- and whitespace-insensitive display-name collision |
| `findByEmail(email)` | Finds a case-insensitive e-mail match |
| `activeAdminCount()` | Counts active admins, used to protect the last remaining one |

### `UserListSection`

Source: [`users/UserListSection.ts`](../../../plugin/obSync/src/settings/users/UserListSection.ts)

Renders the "Registered accounts" list as two sibling `SettingDefinitionGroup`s
rather than one: an always-visible info group (heading, status line, and the
search field), and a separate scrollable group holding one or two
`SettingDefinition` items per user. Splitting them this way keeps the search
box fixed in place while the list beneath it scrolls on its own. The
scrollable group is tagged with the `obsync-user-list-scroll` CSS class,
which is also what keeps its corners rounded during scroll (see
`styles.css`).

Each user contributes an identity row (e-mail, role/status line, and, for
every account except the signed-in admin's own, the active toggle, role
dropdown, and delete button) plus, for non-admin accounts, one compact
sub-row combining the display-name field and a password-reset field so a
single account never grows past two rows. The last active admin has its
toggle, role dropdown, and delete button all disabled, so an admin can't lock
themselves out by demoting or deactivating the only remaining admin account.

`destroy()` resets the load state and bumps an internal generation counter so
an in-flight `listUsers()` call from a previous, now-torn-down instance can't
land its result into a stale directory.

### `UserNameEditor`

Source: [`users/UserNameEditor.ts`](../../../plugin/obSync/src/settings/users/UserNameEditor.ts)

Debounced (500 ms) display-name autosave shared by both `UserListSection`
(editing another user's name, admin only) and `AccountSettingsSection`
(an admin editing their own name). `scheduleSave()` validates length and
name-collision locally before ever calling
`SettingsController.updateUserName()`, and a per-user generation counter
discards a save's result if a newer edit to the same user has started in the
meantime, so an in-flight request can't overwrite a value the user has since
changed again.

### `CreateUserSection`

Source: [`users/CreateUserSection.ts`](../../../plugin/obSync/src/settings/users/CreateUserSection.ts)

Renders the "Add user" form (name, e-mail, initial password, initial role,
and a create button). Checks the pending name and e-mail against the shared
`UserDirectory` before calling `SettingsController.createUser()`, so a
duplicate is rejected locally with the same message the backend would give,
without a round trip. On success it calls `UserDirectory.add()` so the new
account appears in the list immediately, without waiting for the list to be
reloaded or the settings tab to be reopened.
