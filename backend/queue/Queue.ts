import { QueueScheduler } from "./QueueScheduler.ts";

export default class Queue {
  private _queue: Array<{ task: () => Promise<void>; key: string }> = [];
  private _processing: boolean = false;

  public async addTask(operation: () => Promise<void>, taskKey: string): Promise<void> {
    if (!operation) {
      throw new Error("The task is empty");
    }
    if (!taskKey) {
      throw new Error("There is no key identifier");
    }

    await QueueScheduler.isTaskDone(taskKey);
    this._queue.push({ task: operation, key: taskKey });
    this.runTask();
  }

  private async runTask() {
    if (this._processing || this._queue.length == 0) {
      return;
    }

    this._processing = true;

    const task = this._queue.shift();

    if (!task) {
      throw new Error("The task is empty");
    }

    try {
      QueueScheduler._eventEmitter.emit("Processing", task.key);
      await task.task();
    } catch (error) {
      console.log("task could not be finishied", error);
    }
    QueueScheduler._eventEmitter.emit("doneProcessing");
    this._processing = false;
    this.runTask();
  }
  public numberOfTaks() {
    return this._queue.length;
  }
  public get getTaskIdentifiers(): string[] {
    return this._queue.map((someTask) => someTask.key);
  }
}
