import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { systemPaths } from "../../paths.ts";

export class UpdateGene {
  public mutateVaultGene() {
    watch(systemPaths.vault, async () => {
      let vaultGene = await readFile(systemPaths.vaultGene, { encoding: "utf8" });
      let vaultGeneObj = JSON.stringify(vaultGene);
    });
  }
}
