/**
 * Two tasks with the same key never run at once, even in different queues.
 * A key names an operation on a resource, e.g. `user:42:renameUser`.
 */
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

  /** The returned function hands the turn to the next in line. */
  async #enterLine(key: string): Promise<() => void> {
    const { promise, resolve } = Promise.withResolvers<void>();

    const predecessor = this.#lastInLine.get(key);
    this.#lastInLine.set(key, promise);

    if (predecessor) await predecessor;

    return () => {
      if (this.#lastInLine.get(key) === promise) {
        this.#lastInLine.delete(key);
      }
      resolve();
    };
  }

  public get busyKeys(): number {
    return this.#lastInLine.size;
  }
}
