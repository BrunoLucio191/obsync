/** a simple DBqueue */
export class DbQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing: boolean = false;

  public async addTask(task: () => Promise<void>): Promise<void> {
    if (!task) {
      throw new Error("The task is empty");
    }
    this.queue.push(task);
    this.runTask();
  }
  private async runTask() {
    if (this.processing || this.queue.length == 0) {
      return;
    }

    this.processing = true;

    const task = this.queue.shift();

    if (!task) {
      throw new Error("The task is empty");
    }

    try {
      await task();
    } catch (error) {
      console.log("task could not be finishied", error);
    }

    this.processing = false;

    this.runTask();
  }
  public numberOfTaks() {
    return this.queue.length;
  }
}
