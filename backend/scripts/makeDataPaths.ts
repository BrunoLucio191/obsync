import fs from "fs";
import { mkdir } from "node:fs/promises";
import { systemPaths } from "../paths.ts";

/** make sure that the backend has those paths
 * - `vault`
 * - `yjs-state`
 * - `zips`
 */
const makeDataPaths = async () => {
  if (!fs.existsSync(systemPaths.vault)) {
    await mkdir(systemPaths.vault, { recursive: false });
    console.log("[Data] vault directory was created");
  } else {
    console.log("[Data] vault directory already exists!");
  }
  if (!fs.existsSync(systemPaths.yjsState)) {
    await mkdir(systemPaths.yjsState, { recursive: false });
    console.log("[Data] yjs-state directory was created");
  } else {
    console.log("[Data] yjs-state directory already exists!");
  }
  if (!fs.existsSync(systemPaths.zips)) {
    await mkdir(systemPaths.zips, { recursive: false });
    console.log("[Data] zips directory was created");
  } else {
    console.log("[Data] zips directory already exists!");
  }
};

await makeDataPaths();
