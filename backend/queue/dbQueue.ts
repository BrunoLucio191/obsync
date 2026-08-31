/**
 * A minimal FIFO queue of async tasks. Tasks run one at a time, in the order
 * they were added; a task that throws is logged and does not stop later
 * tasks from running.
 *
 * TODO: this only implements plain FIFO ordering. Other queue routes may
 * need different strategies later (e.g. priority ordering, per-task retry,
 * or a concurrency limit greater than one), so factor those out into their
 * own queue types instead of growing this one once that need shows up.
 */

export class DbQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing: boolean = false;

  /** Appends `task` to the queue and starts processing if it's currently idle. */
  public async addTask(task: () => Promise<void>): Promise<void> {
    if (!task) {
      throw new Error("The task is empty");
    }
    this.queue.push(task);
    this.runTask();
  }
  /** Runs the next queued task, then recurses until the queue is drained. */
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
