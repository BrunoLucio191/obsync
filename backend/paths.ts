import path from "node:path";

const backendRoot = import.meta.dirname;
const dataDirectory = path.join(backendRoot, "data");

/** An object with all the paths from the data folder
 * Resolved from the backend's own folder, so the working directory doesn't matter.
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
  vaultGene: path.join(dataDirectory, "gene.json"),
  zips: path.join(dataDirectory, "zips"),
} as const;
