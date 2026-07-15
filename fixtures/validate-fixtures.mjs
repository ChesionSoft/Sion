import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const fixtureRoot = path.join(import.meta.dirname, "legacy-projects", "minimal");
const projectId = "6a6b57e7-cbb6-4c0a-b630-000000000001";
const projectRoot = path.join(fixtureRoot, "projects", projectId);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

const project = await readJson(path.join(projectRoot, "project.json"));
if (project.id !== projectId) throw new Error("fixture project id does not match its directory");

const nodeDir = path.join(projectRoot, "nodes");
const nodeFiles = (await readdir(nodeDir)).filter((file) => file.endsWith(".json"));
if (nodeFiles.length !== 12) throw new Error(`expected 12 workflow nodes, received ${nodeFiles.length}`);
for (const file of nodeFiles) {
  const node = await readJson(path.join(nodeDir, file));
  if (!node.id || typeof node.markdown !== "string" || typeof node.revision !== "number") {
    throw new Error(`invalid node fixture: ${file}`);
  }
}

const sessions = await readJson(path.join(projectRoot, "chat", "basic-info", "index.json"));
if (!sessions[0]?.webSearchEnabled) throw new Error("fixture must exercise browser-search setting removal");
const messages = await readJson(path.join(projectRoot, "chat", "basic-info", `${sessions[0].id}.json`));
if (!messages.some((message) => message.turnId && message.usage && message.sources?.length)) {
  throw new Error("fixture must preserve historical turn usage and source metadata");
}

const files = await readJson(path.join(projectRoot, "files", "index.json"));
for (const file of files) {
  const attachment = await stat(path.join(projectRoot, "files", file.storedName));
  if (attachment.size !== file.byteSize) {
    throw new Error(`${file.storedName}: byteSize ${file.byteSize} does not match ${attachment.size}`);
  }
  if (file.textPath) await stat(path.join(projectRoot, "files", file.textPath));
}

const providers = await readJson(path.join(fixtureRoot, "settings", "model-providers.json"));
if (!providers.every((provider) => provider.apiKey === "not-a-real-secret-fixture")) {
  throw new Error("fixture provider must only contain the documented non-secret placeholder");
}

console.log(`Fixture contract passed: ${nodeFiles.length} nodes, ${sessions.length} session(s), ${files.length} file(s).`);
