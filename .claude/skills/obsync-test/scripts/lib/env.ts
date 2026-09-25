// Shared setup for obSync scenarios. Import this module before any plugin code: it routes
// `obsidian` to the fake module and gives helpers to reach the backend and plugin sources.
import { registerHooks, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

export const REPO = path.resolve(import.meta.dirname, "../../../../..");
export const BACKEND = path.join(REPO, "backend");
export const PLUGIN = path.join(REPO, "plugin/obSync");
export const FAKE_OBSIDIAN_URL = pathToFileURL(path.join(import.meta.dirname, "fake-obsidian.ts")).href;
const REAL_DATA = path.join(BACKEND, "data");

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "obsidian") return { url: FAKE_OBSIDIAN_URL, shortCircuit: true };
    return next(specifier, context);
  },
});
(globalThis as any).window ??= globalThis;

export const backendRequire = createRequire(path.join(BACKEND, "package.json"));
const pluginRequire = createRequire(path.join(PLUGIN, "package.json"));

/** Imports a backend module by its path relative to `backend/`. */
export const backend = (relative: string) => import(pathToFileURL(path.join(BACKEND, relative)).href);

/** The fake `obsidian` module instance the plugin code sees (notices, netStats, TFile...). */
export const fakeObsidian = () => import(FAKE_OBSIDIAN_URL);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Silences console output and sorts errors: lines starting with `[` come from the backend
 * (its logs carry a bracketed prefix), the rest from the plugin. Returns the real
 * console.log as `out` for the scenario's own report.
 */
export function captureLogs() {
  const out = console.log.bind(console);
  const backendErrors: string[] = [];
  const pluginErrors: string[] = [];
  const unhandled: string[] = [];
  console.log = () => {};
  console.warn = () => {};
  console.error = (...args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
    if (text.startsWith("(node:")) return;
    (text.startsWith("[") ? backendErrors : pluginErrors).push(text);
  };
  process.on("unhandledRejection", (e) => unhandled.push(String((e as Error)?.message ?? e)));
  return { out, backendErrors, pluginErrors, unhandled };
}

/**
 * Points every backend data path (users DB, vault, zips, gene, Yjs state) at a fresh temp
 * dir, and throws before anything is written if one of them still points at backend/data.
 */
export async function useTempData() {
  const { systemPaths } = await backend("paths.ts");
  const paths = systemPaths as Record<string, string>;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsync-test-"));
  const targets: Record<string, string> = {
    dataDirectory: root,
    usersDatabase: path.join(root, "users.sqlite"),
    vault: path.join(root, "vault"),
    vaultExit: path.join(root, "vault", "vault.zip"),
    yjsState: path.join(root, "yjs-state"),
    vaultGene: path.join(root, "gene.json"),
    zips: path.join(root, "zips"),
  };
  for (const [key, value] of Object.entries(targets)) paths[key] = value;
  for (const [key, value] of Object.entries(paths)) {
    if (typeof value === "string" && value.startsWith(REAL_DATA)) {
      throw new Error(`[obsync-test] ${key} still points at backend/data, refusing to run`);
    }
  }
  for (const dir of ["vault", "yjsState", "zips"]) await fs.mkdir(paths[dir], { recursive: true });
  await fs.writeFile(
    paths.vaultGene,
    JSON.stringify({ generation: 0, bytes: 0, filesCount: 0, lastModification: "" }),
  );
  return { root, paths, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/**
 * Bundles plugin modules with the plugin's own esbuild and imports them. Bundling (instead of
 * importing the .ts files directly) drops imports that are only used as types, which Node's
 * type stripping keeps and then fails on, and gives every module one shared state (ApiConfig).
 * @param modules - export name -> path relative to plugin/obSync/src
 */
export async function bundlePlugin(modules: Record<string, string>): Promise<any> {
  const esbuild = pluginRequire("esbuild");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsync-test-bundle-"));
  const entry = path.join(dir, "entry.ts");
  await fs.writeFile(
    entry,
    Object.entries(modules)
      .map(([name, file]) => `export { ${name} } from ${JSON.stringify(path.join(PLUGIN, "src", file))};`)
      .join("\n"),
  );
  const outfile = path.join(dir, "bundle.mjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["obsidian"],
    outfile,
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  await fs.rm(dir, { recursive: true, force: true });
  return loaded;
}
