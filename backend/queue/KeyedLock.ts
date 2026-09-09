/**
 * Each Queue orders the tasks of a single user. This lock adds the other
 * half: two tasks with the same key never run at the same time, even when they
 * sit in different queues. Keys are standardized per route, so they identify an
 * operation on a resource, such as `user:42:renameUser`.
 */

//  done -> key2 | outra coisa
//  not done -> key1 | fazer alguma coisa
//  not done -> key1 | fazer alguma coisa

export class KeyedLock {
  #lastInLine = new Map<string, Promise<void>>();

  public async run<T>(operation: () => Promise<T>, key: string): Promise<T> {
    if (!key) {
      throw new Error("[KeyedLock] There is no key identifier");
    }
    const release = await this.#enterLine(key);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Waits for this key's turn and returns the function that hands the turn over
   * to whoever is next in line.
   */
  async #enterLine(key: string): Promise<() => void> {
    const { promise, resolve } = Promise.withResolvers<void>();

    const predecessor = this.#lastInLine.get(key);
    this.#lastInLine.set(key, promise);

    if (predecessor) {
      await predecessor;
    }

    return () => {
      if (this.#lastInLine.get(key) === promise) {
        this.#lastInLine.delete(key);
      }
      resolve();
    };
  }

  /** Number of keys currently held or waited on. Meant for logging and tests. */
  public get busyKeys(): number {
    return this.#lastInLine.size;
  }
}
