import { FileManager } from "../Server/FileManager.ts";

export class BufferQueue {
  private queue: Array<{ buffer: Buffer<ArrayBuffer>; path: string }> = [];
  private processing: boolean = false;
  private fileManager: FileManager;

  constructor(fileManager: FileManager) {
    this.fileManager = fileManager;
  }

  public async addTask(task: Buffer<ArrayBuffer>, path: string): Promise<void> {
    if (!task) {
      throw new Error("the task is empty");
    }
    this.queue.push({ buffer: task, path: path });
    console.log(path);
    this.runTask();
  }
  private async runTask() {
    if (this.processing || this.queue.length == 0) {
      return;
    }
    this.processing = true;

    const task = this.queue.shift();

    try {
      await this.fileManager.createOrModifyFile(task.path, task.buffer);
    } catch (error) {
      console.error("task could not be finishied", error);
    }
    this.processing = false;
    this.runTask();
  }
}
