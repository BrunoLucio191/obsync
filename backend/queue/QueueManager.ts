import { DbQueue } from "./dbQueue.ts";

/**
 * Lazily creates and caches one {@link DbQueue} per user id, so every caller
 * mutating the same user shares a single FIFO queue instead of racing each
 * other with independent queues.
 */
export class QueueManager {
  private queuesRecord = new Map<string, DbQueue>();

  /** Returns the existing queue for `userId`, creating one on first use. */
  public creatQueueOrReturn(userId: string): DbQueue {
    if (!this.queuesRecord.has(userId)) {
      const queue = new DbQueue();
      this.queuesRecord.set(userId, queue);
    }

    const queue = this.queuesRecord.get(userId);

    if (!queue) {
      throw new Error("there is not queue");
    }
    return queue;
  }
}
