import type { KeyedLock } from "./KeyedLock.ts";

/**
 * Runs tasks one at a time, in arrival order. Each task first takes the shared KeyedLock
 * for its key, so it waits while another queue runs something with the same key.
 */
export default class Queue {
  #queue: Array<{ task: () => Promise<void>; taskKey: string }> = [];
  #processing: boolean = false;
  #lock: KeyedLock;
  #onEmpty?: () => void;

  constructor(lock: KeyedLock, onEmpty?: () => void) {
    this.#lock = lock;
    this.#onEmpty = onEmpty;
  }

  public addTask<T>(task: () => Promise<T>, taskKey: string): Promise<T> {
    if (!task) {
      throw new Error("[Queue] The task is empty");
    }
    if (!taskKey) {
      throw new Error("[Queue] There is no key identifier");
    }
    const { promise, reject, resolve } = Promise.withResolvers<T>();

    this.#queue.push({
      task: async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      },
      taskKey,
    });
    void this.#runTask();
    return promise;
  }

  async #runTask(): Promise<void> {
    if (this.#processing) {
      return;
    }
    if (this.#queue.length === 0) {
      this.#onEmpty?.();
      return;
    }

    this.#processing = true;

    const taskObj = this.#queue.shift();

    if (!taskObj) {
      console.warn("[Queue] Tried to run a task but the queue was empty");
      this.#processing = false;
      return;
    }

    try {
      await this.#lock.run(taskObj.task, taskObj.taskKey);
    } catch (error) {
      console.error(`[Queue] The task "${taskObj.taskKey}" could not be finished`, error);
    } finally {
      this.#processing = false;
    }

    this.#runTask();
  }
  public get numberOfTaks(): number {
    return this.#queue.length;
  }

  public get getTaskIdentifiers(): string[] {
    return this.#queue.map((someTask) => someTask.taskKey);
  }

  public get isProcessing() {
    return this.#processing;
  }
}
