import Queue from "../queue/Queue.ts";
import type { KeyedLock } from "./KeyedLock.ts";

/**
 * Menages all queues that are created per user. Every queue it builds shares the
 * same {@link KeyedLock}, so two users running the same keyed operation still
 * wait for each other even though their queues are independent.
 */
export class QueueManager {
  public _dbQueuesRecord = new Map<string, Queue>();
  #lock: KeyedLock;

  constructor(lock: KeyedLock) {
    this.#lock = lock;
  }

  public creatDBQueueOrReturn(userID: string): Queue {
    if (!userID) {
      throw new Error("[QueueManager] There is no user identifier");
    }

    let queue = this._dbQueuesRecord.get(userID);

    if (!queue) {
      queue = new Queue(this.#lock);
      this._dbQueuesRecord.set(userID, queue);
    }

    return queue;
  }
}
