import type { AuthenticatedUser } from '../../auth/auth.types.ts';

/** Local copy of the user list, updated after each action so the UI doesn't re-fetch it. */
export class UserDirectory {
	#users: AuthenticatedUser[] = [];

	public replaceAll(users: AuthenticatedUser[]): void {
		this.#users = [...users].sort((first, second) => first.id - second.id);
	}

	public replace(updatedUser: AuthenticatedUser): void {
		const index = this.#users.findIndex(
			(user) => user.id === updatedUser.id,
		);
		if (index !== -1) this.#users[index] = updatedUser;
	}

	/** Ignores an id already cached, so a stale double call can't duplicate a row. */
	public add(newUser: AuthenticatedUser): void {
		if (this.#users.some((user) => user.id === newUser.id)) return;

		const insertAt = this.#users.findIndex((user) => user.id > newUser.id);
		if (insertAt === -1) {
			this.#users.push(newUser);
		} else {
			this.#users.splice(insertAt, 0, newUser);
		}
	}

	public remove(userId: number): void {
		this.#users = this.#users.filter((user) => user.id !== userId);
	}

	public search(query: string): AuthenticatedUser[] {
		const normalizedQuery = this.#normalizeSearch(query);
		if (!normalizedQuery) return this.all();

		return this.#users.filter(
			(user) =>
				this.#normalizeSearch(user.name).includes(normalizedQuery) ||
				this.#normalizeSearch(user.email).includes(normalizedQuery),
		);
	}

	public findByName(
		name: string,
		exceptUserId?: number,
	): AuthenticatedUser | undefined {
		const key = this.#normalizeUniqueName(name);
		if (!key) return undefined;

		return this.#users.find(
			(user) =>
				user.id !== exceptUserId &&
				this.#normalizeUniqueName(user.name) === key,
		);
	}

	public findByEmail(email: string): AuthenticatedUser | undefined {
		const key = email.normalize('NFKC').trim().toLocaleLowerCase();
		if (!key) return undefined;

		return this.#users.find(
			(user) =>
				user.email.normalize('NFKC').trim().toLocaleLowerCase() === key,
		);
	}

	public activeAdminCount(): number {
		return this.#users.filter(
			(user) => user.active && user.role === 'admin',
		).length;
	}

	public all(): AuthenticatedUser[] {
		return [...this.#users];
	}

	public get size(): number {
		return this.#users.length;
	}

	#normalizeUniqueName(value: string): string {
		return value
			.normalize('NFKC')
			.trim()
			.replace(/\s+/g, ' ')
			.toLocaleLowerCase('pt-BR');
	}

	#normalizeSearch(value: string): string {
		return value
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.trim()
			.toLocaleLowerCase();
	}
}
