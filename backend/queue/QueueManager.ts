import Queue from "../queue/Queue.ts";

export class QueueManager {
  public _dbQueuesRecord = new Map<string, Queue>();
  static lastUserId = "";

  public creatDBQueueOrReturn(userID: string): Queue {
    QueueManager.lastUserId = userID;
    if (!this._dbQueuesRecord.has(userID)) {
      const queue = new Queue();
      this._dbQueuesRecord.set(userID, queue);
    }

    const queue = this._dbQueuesRecord.get(userID);

    if (!queue) {
      throw new Error("there is no queue");
    }
    return queue;
  }
  static get getLastUser() {
    return QueueManager.lastUserId;
  }
}
