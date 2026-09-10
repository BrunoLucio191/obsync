import type { KeyedLock } from "./KeyedLock.ts";

/**
 * A simple abstraction of a queue, each task has an async function
 * with a standardized key.
 *
 * Tasks run one at a time, in arrival order. Before running a task the
 * queue takes the shared KeyedLock for its key, which makes a task wait
 * while another queue is already running something with the same key.
 */
export default class Queue {
  #queue: Array<{ task: () => Promise<void>; taskKey: string }> = [];
  #processing: boolean = false;
  #lock: KeyedLock;

  constructor(lock: KeyedLock) {
    this.#lock = lock;
  }

  /** Adds a task to the #queue that is an array, and starts draining it if idle. */
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
    if (this.#processing || this.#queue.length === 0) {
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

  public numberOfTaks(): number {
    return this.#queue.length;
  }

  /**
   * Returns an array with all task keys identifiers
   */
  public get getTaskIdentifiers(): string[] {
    return this.#queue.map((someTask) => someTask.taskKey);
  }
  public get isProcessing() {
    return this.#processing;
  }
}
