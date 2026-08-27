import type { AuthenticatedUser } from '../../auth/auth.types.ts';

/**
 * In-memory, id-sorted cache of user accounts backing the user-management
 * settings UI. Holds the last `listUsers()` fetch and is kept in sync
 * locally as create/update/delete mutations succeed, so the UI doesn't need
 * to re-fetch the whole list after every action.
 */
export class UserDirectory {
	private users: AuthenticatedUser[] = [];

	/** Replaces the entire cache, e.g. after a fresh `listUsers()` fetch. */
	public replaceAll(users: AuthenticatedUser[]): void {
		this.users = [...users].sort((first, second) => first.id - second.id);
	}

	/** Overwrites a single cached user, matched by `id`; no-op if the id isn't cached. */
	public replace(updatedUser: AuthenticatedUser): void {
		const index = this.users.findIndex(
			(user) => user.id === updatedUser.id,
		);
		if (index !== -1) this.users[index] = updatedUser;
	}

	/**
	 * Inserts a user created after the initial listUsers() fetch, keeping the
	 * id ordering replaceAll() establishes. A no-op if the id is already
	 * cached, so a stale double-call can't create a duplicate row.
	 */
	public add(newUser: AuthenticatedUser): void {
		if (this.users.some((user) => user.id === newUser.id)) return;

		const insertAt = this.users.findIndex((user) => user.id > newUser.id);
		if (insertAt === -1) {
			this.users.push(newUser);
		} else {
			this.users.splice(insertAt, 0, newUser);
		}
	}

	public remove(userId: number): void {
		this.users = this.users.filter((user) => user.id !== userId);
	}

	/** Filters cached users by a case/accent-insensitive match against name or email; an empty query returns every user. */
	public search(query: string): AuthenticatedUser[] {
		const normalizedQuery = this.normalizeSearch(query);
		if (!normalizedQuery) return this.all();

		return this.users.filter(
			(user) =>
				this.normalizeSearch(user.name).includes(normalizedQuery) ||
				this.normalizeSearch(user.email).includes(normalizedQuery),
		);
	}

	/**
	 * Looks up a user by exact (normalized, case-insensitive) display name,
	 * used to prevent duplicate names when creating or renaming a user.
	 * @param exceptUserId - A user id to exclude from the search, e.g. the user currently being renamed.
	 */
	public findByName(
		name: string,
		exceptUserId?: number,
	): AuthenticatedUser | undefined {
		const key = this.normalizeUniqueName(name);
		if (!key) return undefined;

		return this.users.find(
			(user) =>
				user.id !== exceptUserId &&
				this.normalizeUniqueName(user.name) === key,
		);
	}

	/** Looks up a user by exact (normalized, case-insensitive) email, used to prevent duplicate accounts when creating a user. */
	public findByEmail(email: string): AuthenticatedUser | undefined {
		const key = email.normalize('NFKC').trim().toLocaleLowerCase();
		if (!key) return undefined;

		return this.users.find(
			(user) =>
				user.email.normalize('NFKC').trim().toLocaleLowerCase() === key,
		);
	}

	/** The number of active admins, used to prevent demoting/deactivating/deleting the last remaining one. */
	public activeAdminCount(): number {
		return this.users.filter(
			(user) => user.active && user.role === 'admin',
		).length;
	}

	public all(): AuthenticatedUser[] {
		return [...this.users];
	}

	public get size(): number {
		return this.users.length;
	}

	/**
	 * Normalizes a display name for uniqueness comparisons: Unicode
	 * normalization, trimming, collapsing internal whitespace, and
	 * locale-aware (`pt-BR`) lowercasing.
	 */
	private normalizeUniqueName(value: string): string {
		return value
			.normalize('NFKC')
			.trim()
			.replace(/\s+/g, ' ')
			.toLocaleLowerCase('pt-BR');
	}

	/** Normalizes a string for accent/case-insensitive substring search by stripping diacritics after Unicode decomposition. */
	private normalizeSearch(value: string): string {
		return value
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.trim()
			.toLocaleLowerCase();
	}
}
