import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const dependencies = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
};
const forbiddenDependencies = ["next", "playwright", "playwright-core"];

for (const dependency of forbiddenDependencies) {
  if (dependency in dependencies) {
    throw new Error(`desktop runtime must not declare ${dependency}`);
  }
}

const forbiddenFileNames = [
  "baidu-search",
  "browser-egress-proxy",
  "browser-manager",
  "browser-registry",
  "browser-verification",
  "browser-web-service",
  "google-search",
  "playwright-loader",
  "search-engine",
  "search-planner",
  "web-tool",
];

async function filesAt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "target" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesAt(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

for (const sourceDirectory of ["src", "src-tauri", "crates"]) {
  const absoluteDirectory = fileURLToPath(new URL(`../${sourceDirectory}/`, import.meta.url));
  if (!(await stat(absoluteDirectory)).isDirectory()) {
    throw new Error(`missing desktop source directory: ${sourceDirectory}`);
  }
  for (const file of await filesAt(absoluteDirectory)) {
    const name = basename(file).toLowerCase();
    const forbidden = forbiddenFileNames.find((fragment) => name.includes(fragment));
    if (forbidden) {
      throw new Error(`desktop runtime must not retain ${forbidden}: ${relative(root, file)}`);
    }
    if (/\.(?:rs|tsx?|mjs)$/.test(name)) {
      const content = await readFile(file, "utf8");
      if (/\bplaywright\b/i.test(content)) {
        throw new Error(`desktop runtime must not reference Playwright: ${relative(root, file)}`);
      }
    }
  }
}

console.log("verified: the desktop runtime has no browser-search implementation");
