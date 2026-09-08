import { EventEmitter } from "node:events";

export class QueueScheduler {
  static _eventEmitter = new EventEmitter();
  static async isTaskDone(taskKey: string): Promise<boolean> {
    return new Promise((resolve, rejects) => {
      try {
        this._eventEmitter.on("Processing", (runningTaskId) => {
          if (taskKey === runningTaskId) {
            this._eventEmitter.on("doneProcessing", () => {
              resolve(true);
            });
          }
        });
      } catch (error) {
        rejects(error);
      }
    });
  }
}
