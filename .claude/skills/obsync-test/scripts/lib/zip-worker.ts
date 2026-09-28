// A stand-in for the Web Worker ZipWorkerSon spawns: unzips with the plugin's own JSZip and
// answers with the same message shape as plugin/obSync/src/Workers/zipWorker/zip.worker.ts.
import { createRequire } from "node:module";
import path from "node:path";
import { PLUGIN } from "./env.ts";

const JSZip = createRequire(path.join(PLUGIN, "package.json"))("jszip");

/** Replaces the global Worker; `jobs` counts unzips still running. */
export function installZipWorker() {
  const state = { jobs: 0, created: 0 };
  (globalThis as any).Worker = class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    constructor() {
      state.created++;
    }
    async postMessage(zipData: ArrayBuffer) {
      state.jobs++;
      try {
        const zip = await JSZip.loadAsync(zipData);
        const entries = [];
        for (const relativePath of Object.keys(zip.files)) {
          const entry = zip.files[relativePath];
          if (entry.dir) entries.push({ path: relativePath, isDir: true });
          else {
            const content = await entry.async("arraybuffer");
            entries.push({ path: relativePath, isDir: false, content, ext: relativePath.slice(relativePath.lastIndexOf(".")) });
          }
        }
        this.onmessage?.({ data: { status: "success", entries } });
      } catch (error) {
        this.onmessage?.({ data: { status: "error", message: String(error) } });
      } finally {
        state.jobs--;
      }
    }
    terminate() {}
  };
  return state;
}
