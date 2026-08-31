import { DbQueue } from "./dbQueue.ts";

/** responsible for creating and storing Queues per users */
export class QueueManager {
  private queuesRecord = new Map<string, DbQueue>();

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
