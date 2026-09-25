// A client's local vault, firing vault events the way Obsidian 1.13 does.
import fs from "node:fs/promises";
import path from "node:path";
import { fakeObsidian } from "./env.ts";

const { TFile, TFolder } = await fakeObsidian();

/** Every handler promise and pending watcher timer, so a scenario can wait for quiet. */
export const activity = { pending: [] as Promise<unknown>[], watcherTimers: 0, handlerErrors: [] as string[] };

/**
 * User actions (createFile, modify, delete, rename) fire events right away, with handlers
 * called synchronously and not awaited, like Obsidian. Adapter writes, which is what
 * RemoteVaultChangeService uses, fire their events 5-40ms later like Obsidian's file watcher.
 * rename follows Obsidian's adapter.rename: the item first, then one event per descendant.
 */
export class FakeVault {
  #handlers = new Map<string, Function[]>();
  entries = new Map<string, any>();
  contents = new Map<string, string>();
  #name: string;

  constructor(name = "Test Vault") {
    this.#name = name;
  }
  getName() {
    return this.#name;
  }
  on(name: string, cb: Function) {
    if (!this.#handlers.has(name)) this.#handlers.set(name, []);
    this.#handlers.get(name)!.push(cb);
    return { name, cb };
  }
  trigger(name: string, ...args: unknown[]) {
    for (const cb of this.#handlers.get(name) ?? []) {
      let result: unknown;
      try {
        result = cb(...args);
      } catch (error) {
        result = Promise.reject(error);
      }
      activity.pending.push(
        Promise.resolve(result).catch((e) => activity.handlerErrors.push(String(e?.message ?? e))),
      );
    }
  }
  #watch(name: string, ...args: unknown[]) {
    activity.watcherTimers++;
    setTimeout(() => {
      activity.watcherTimers--;
      this.trigger(name, ...args);
    }, 5 + Math.random() * 35);
  }
  /** Obsidian throws when reading a file that no longer exists. */
  #alive(file: any) {
    if (this.entries.get(file.path) !== file) throw new Error(`ENOENT: ${file.path}`);
  }
  async read(file: any) {
    this.#alive(file);
    return this.contents.get(file.path) ?? "";
  }
  async readBinary(file: any) {
    this.#alive(file);
    return new TextEncoder().encode(this.contents.get(file.path) ?? "").buffer;
  }
  getAbstractFileByPath(p: string) {
    return this.entries.get(p) ?? null;
  }

  /** Adds entries without firing events, for the starting state. */
  seed(p: string, content?: string) {
    this.entries.set(p, content === undefined ? new TFolder(p) : new TFile(p));
    if (content !== undefined) this.contents.set(p, content);
  }
  createFile(p: string, content: string) {
    const file = new TFile(p);
    this.entries.set(p, file);
    this.contents.set(p, content);
    this.trigger("create", file);
  }
  createFolder(p: string) {
    const folder = new TFolder(p);
    this.entries.set(p, folder);
    this.trigger("create", folder);
  }
  modify(p: string, content: string) {
    this.contents.set(p, content);
    this.trigger("modify", this.entries.get(p));
  }
  delete(p: string) {
    for (const removed of this.#removeTree(p)) this.trigger("delete", removed);
  }
  rename(oldPath: string, newPath: string) {
    const item = this.entries.get(oldPath);
    if (!item) return;
    const moves: [string, string, any][] = [[oldPath, newPath, item]];
    if (item instanceof TFolder) {
      for (const [p, child] of this.entries) {
        if (p.startsWith(`${oldPath}/`)) moves.push([p, newPath + p.slice(oldPath.length), child]);
      }
    }
    for (const [from, to, obj] of moves) {
      this.entries.delete(from);
      obj.path = to;
      this.entries.set(to, obj);
      if (this.contents.has(from)) {
        this.contents.set(to, this.contents.get(from)!);
        this.contents.delete(from);
      }
      this.trigger("rename", obj, from);
    }
  }
  #removeTree(p: string): any[] {
    const root = this.entries.get(p);
    if (!root) return [];
    const removed = [root, ...[...this.entries].filter(([q]) => q.startsWith(`${p}/`)).map(([, o]) => o)];
    for (const obj of removed) {
      this.entries.delete(obj.path);
      this.contents.delete(obj.path);
    }
    return removed;
  }
  #adapterWrite(p: string, content: string) {
    const existing = this.entries.get(p);
    this.contents.set(p, content);
    if (existing) return this.#watch("modify", existing);
    const file = new TFile(p);
    this.entries.set(p, file);
    this.#watch("create", file);
  }

  adapter = {
    exists: async (p: string) => this.entries.has(p),
    mkdir: async (p: string) => {
      if (this.entries.has(p)) return;
      const folder = new TFolder(p);
      this.entries.set(p, folder);
      this.#watch("create", folder);
    },
    write: async (p: string, data: string) => this.#adapterWrite(p, data),
    writeBinary: async (p: string, data: ArrayBuffer) => this.#adapterWrite(p, new TextDecoder().decode(data)),
    remove: async (p: string) => this.#removeTree(p).forEach((o) => this.#watch("delete", o)),
    rmdir: async (p: string) => this.#removeTree(p).forEach((o) => this.#watch("delete", o)),
    rename: async (a: string, b: string) => this.rename(a, b),
  };
  fileManager = {
    trashFile: async (file: any) => this.#removeTree(file.path).forEach((o) => this.#watch("delete", o)),
  };

  /** Sorted `folder/` and `file=content` lines, optionally only under `prefix`. */
  tree(prefix?: string): string[] {
    return [...this.entries.keys()]
      .filter((p) => !prefix || p === prefix || p.startsWith(`${prefix}/`))
      .map((p) => (this.entries.get(p) instanceof TFolder ? `${p}/` : `${p}=${this.contents.get(p)}`))
      .sort();
  }
}

/** Same format as FakeVault.tree, read from a directory on disk (the server's vault). */
export async function diskTree(dir: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(`${rel}/`, ...(await diskTree(path.join(dir, entry.name), rel)));
    else result.push(`${rel}=${await fs.readFile(path.join(dir, entry.name), "utf8")}`);
  }
  return result.sort();
}

/** Resolves once no request, watcher event or handler has been running for `quietMs`. */
export async function waitForQuiet(netStats: { inFlight: number }, quietMs = 500) {
  let quietSince = performance.now();
  while (performance.now() - quietSince < quietMs) {
    const count = activity.pending.length;
    await Promise.all(activity.pending);
    if (netStats.inFlight > 0 || activity.watcherTimers > 0 || activity.pending.length !== count) {
      quietSince = performance.now();
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
