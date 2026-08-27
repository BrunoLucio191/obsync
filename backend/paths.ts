import path from "node:path";

const backendRoot = import.meta.dirname;
const dataDirectory = path.join(backendRoot, "data");

/**
 * Central registry of filesystem paths used across the backend, all
 * resolved relative to the backend's own root directory so the process
 * works regardless of the current working directory it was started from.
 */
export const systemPaths = {
  backendRoot,
  dataDirectory,

  //database file
  usersDatabase: path.join(dataDirectory, "users.sqlite"),

  //vault directory inside the backend
  vault: path.join(dataDirectory, "vault"),

  //Zip file that is send with all the content when user open
  //the vault when opening the app
  vaultExit: path.join(dataDirectory, "vault", "vault.zip"),

  //yjs persistente state file
  yjsState: path.join(dataDirectory, "yjs-state"),
} as const;
