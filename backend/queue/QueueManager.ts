import { Queue } from "./dbQueue.ts";
/**
 * Lazily creates and caches one {@link Queue} per user id, so every caller
 * mutating the same user shares a single FIFO queue instead of racing each
 * other with independent queues.
 */
export class QueueManager {
  private dbQueuesRecord = new Map<string, Queue>();

  /** Returns the existing queue for `userId`, creating one on first use. */
  public creatDBQueueOrReturn(userID: string): Queue {
    if (!this.dbQueuesRecord.has(userID)) {
      const queue = new Queue();
      this.dbQueuesRecord.set(userID, queue);
    }

    const queue = this.dbQueuesRecord.get(userID);

    if (!queue) {
      throw new Error("there is no queue");
    }
    return queue;
  }
}
