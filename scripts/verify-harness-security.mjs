import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const source = async (path) => readFile(new URL(path, root), "utf8");
const productionSource = (text) => text.split("#[cfg(test)]", 1)[0];

const readToolNames = [
  "list_project_attachments",
  "read_attachment",
  "list_dependency_sections",
  "read_dependency_section",
  "search_allowed_context",
  "read_current_delivery",
  "read_effective_agent_rule",
];
const planningToolNames = [
  "request_delivery_execution",
  "propose_agent_rule_override",
  "revise_agent_rule_proposal",
  "discard_agent_rule_proposal",
];
const executionToolNames = ["apply_current_delivery_change"];
const approvedToolNames = new Set([
  ...readToolNames,
  ...planningToolNames,
  ...executionToolNames,
]);

const [toolsRaw, proposalsRaw, executionRaw, runtime, lib] = await Promise.all([
  source("src-tauri/src/harness_tools.rs"),
  source("src-tauri/src/harness_proposals.rs"),
  source("src-tauri/src/harness_execution.rs"),
  source("src-tauri/src/harness_runtime.rs"),
  source("src-tauri/src/lib.rs"),
]);
const tools = productionSource(toolsRaw);
const proposals = productionSource(proposalsRaw);
const execution = productionSource(executionRaw);

const registered = new Set();
for (const text of [tools, proposals, execution]) {
  for (const match of text.matchAll(/tool\(\s*\n\s*"([a-z_]+)"/g)) {
    registered.add(match[1]);
  }
}
for (const name of registered) {
  if (!approvedToolNames.has(name)) throw new Error(`unapproved Harness tool: ${name}`);
}
for (const name of approvedToolNames) {
  if (!registered.has(name)) throw new Error(`approved Harness tool is not registered: ${name}`);
}

for (const name of readToolNames) {
  if (!runtime.includes(`"${name}"`)) throw new Error(`read tool is not routed: ${name}`);
}
for (const name of planningToolNames) {
  if (!runtime.includes(`"${name}"`)) throw new Error(`proposal tool is not routed: ${name}`);
}
for (const name of executionToolNames) {
  if (!execution.includes(`"${name}"`)) throw new Error(`execution tool is not defined: ${name}`);
}
if (/propose_delivery_change|revise_delivery_proposal|discard_delivery_proposal/.test(productionSource(proposalsRaw))) {
  throw new Error("new planning Harness must not expose legacy delivery proposal tools");
}

const forbiddenSchemaArgument = /["'](?:path|filePath|directory|glob|url|uri|endpoint|command|shell|browser|code)["']\s*:/i;
for (const [path, text] of [["harness_tools.rs", tools], ["harness_proposals.rs", proposals], ["harness_execution.rs", execution]]) {
  if (forbiddenSchemaArgument.test(text)) {
    throw new Error(`${path} exposes a forbidden raw model argument`);
  }
}

const requestStart = lib.indexOf("struct HarnessProposalRequest");
const requestEnd = lib.indexOf("enum HarnessProposalResolution", requestStart);
if (requestStart < 0 || requestEnd < 0) throw new Error("missing Harness proposal request contract");
const proposalRequest = lib.slice(requestStart, requestEnd);
for (const forbiddenField of ["content", "markdown", "changes", "patch", "base_revision", "baseRuleDigest"]) {
  if (new RegExp(`\\b${forbiddenField}\\b`, "i").test(proposalRequest)) {
    throw new Error(`proposal resolution must not accept ${forbiddenField}`);
  }
}
for (const requiredField of ["project_id", "node_id", "session_id", "turn_id", "proposal_id"]) {
  if (!proposalRequest.includes(requiredField)) {
    throw new Error(`proposal resolution is missing scope field ${requiredField}`);
  }
}

if (!/kind:\s*sion_agent::AgentRunKind::Harness/.test(runtime)) {
  throw new Error("new node starts must schedule AgentRunKind::Harness");
}
if (!/AgentRunKind::HarnessExecution/.test(`${runtime}\n${lib}`) || !/consume_execution_plan/.test(runtime)) {
  throw new Error("confirmed execution must consume a trusted plan before HarnessExecution");
}
if (/kind:\s*sion_agent::AgentRunKind::DeliveryDecision/.test(runtime)) {
  throw new Error("Harness start must not enqueue DeliveryDecision");
}
const handlerStart = lib.indexOf("tauri::generate_handler![");
const handlerEnd = lib.indexOf("])\n", handlerStart);
const commandRegistry = lib.slice(handlerStart, handlerEnd);
if (commandRegistry.includes("conversation_turn_retry_delivery")) {
  throw new Error("legacy delivery retry command remains externally reachable");
}

console.log("verified: Harness tools and proposal resolution remain document-scoped");
