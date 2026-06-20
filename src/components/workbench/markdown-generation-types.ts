import type {
  ModelProvider,
  NodeMarkdownPatch,
  ProjectNode,
  ReasoningEffort,
} from "@/lib/project/types";

export type MarkdownGenerationState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "previewing_increment"; patches: NodeMarkdownPatch[]; baseRevision: number }
  | { phase: "submitting_increment" }
  | { phase: "previewing_rewrite"; candidate: string }
  | { phase: "conflict"; latestNode: ProjectNode; candidate?: string }
  | { phase: "error"; message: string };

export type SharedWorkbenchContext = {
  activeSessionId: string;
  setActiveSessionId: (id: string) => void;
  providerId: string;
  setProviderId: (id: string) => void;
  model: string;
  setModel: (m: string) => void;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (r: ReasoningEffort) => void;
  providers: ModelProvider[];
  setProviders: (p: ModelProvider[]) => void;
};