import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

const forbidden = [
  "src-tauri/src/migration.rs",
  "src-tauri/src/provider_migration.rs",
  "fixtures/validate-fixtures.mjs",
];

for (const path of forbidden) {
  try {
    await access(path, constants.F_OK);
    throw new Error(`legacy migration runtime must not retain ${path}`);
  } catch (error) {
    if (!String(error).includes("ENOENT")) throw error;
  }
}

const rust = await readFile("src-tauri/src/lib.rs", "utf8");
for (const command of ["migration_inspect", "migration_run", "provider_migration_run"]) {
  if (rust.includes(command)) throw new Error(`legacy migration command remains: ${command}`);
}

console.log("verified: the desktop runtime has no legacy migration subsystem");
