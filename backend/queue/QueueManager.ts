import Queue from "../queue/Queue.ts";
import type { KeyedLock } from "./KeyedLock.ts";

const QUEUE_LIFESPAN = 5 * 60 * 1000;
/**
 * Menages all queues that are created per user. Every queue it builds shares the
 * same Keyed Lock, so two users running the same keyed operation still
 * wait for each other even though their queues are independent.
 */
export class QueueManager {
  #dbQueuesRecord = new Map<string, Queue>();
  #queueLifeCicle = new Map<string, number>();
  #lock: KeyedLock;

  constructor(lock: KeyedLock) {
    this.#lock = lock;
  }

  public getOrCreateQueue(userId: string): Queue {
    if (!userId) {
      throw new Error("[QueueManager] There is no user identifier");
    }

    let queue = this.#dbQueuesRecord.get(userId);

    if (this.#queueLifeCicle.get(userId)) {
      const dateOfBirth = this.#queueLifeCicle.get(userId);
      if (dateOfBirth) {
        this.#queueLifeCicle.set(userId, Date.now() + QUEUE_LIFESPAN);
      }
    }
    if (!queue) {
      queue = new Queue(this.#lock);
      this.#dbQueuesRecord.set(userId, queue);
      this.#queueLifeCicle.set(userId, Date.now() + QUEUE_LIFESPAN);
    }
    this.addTimers(userId);
    return queue;
  }
  /** Add life cycle timers for the queues
   *
   * @param userId the same userId identifier used for adding the queue in the dbQueuesRecord
   */
  public addTimers(userId: string) {
    setTimeout(() => {
      const dateOfBirth = this.#queueLifeCicle.get(userId);

      if (!dateOfBirth) return;
      if (Date.now() > dateOfBirth) {
        const queue = this.#dbQueuesRecord.get(userId);
        if (!queue) return;
        let context = this;
        (function loop() {
          setTimeout(function () {
            if (!queue.isProcessing) {
              context.#dbQueuesRecord.delete(userId);
              context.#queueLifeCicle.delete(userId);
              return;
            }
            loop();
          }, 250);
        })();
      }
    }, QUEUE_LIFESPAN);
  }
}
