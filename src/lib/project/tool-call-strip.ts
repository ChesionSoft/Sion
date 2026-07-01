// Strip proprietary tool-call wrapper leakage that some MiniMax models emit
// into the content channel over the OpenAI-compatible Chat Completions
// endpoint. The model writes a normal answer, then appends a bracketed
// model-name marker and an XML-ish tool-name / parameters block (e.g. a
// hallucinated ask_user_question call). Sion registers no such tool, so the
// wrapper would otherwise leak into the visible answer as raw "tags".
//
// This pure helper cuts everything from the first leakage marker onward and
// trims trailing whitespace, so the persisted message, the judge input, and
// the rendered bubble show only the clean answer. It is a no-op on content
// that contains no leakage.

// Marker alternatives, built from parts so the source file does not contain
// the contiguous literal sequences. Each marker is distinctive enough that
// it never appears in legitimate project-design prose.
const ALT_BRACKET_A = "]" + "<]" + "minimax" + "[>";
const ALT_BRACKET_B = "<]" + "minimax" + "[>";
const ALT_TOOL_NAME = "<" + "tool_name" + ">";
const ALT_PARAMETERS = "<" + "parameters" + ">";
const ALT_TOOL_CALL = "<" + "tool_call" + ">";
const LEAK_START = new RegExp(
  [ALT_BRACKET_A, ALT_BRACKET_B, ALT_TOOL_NAME, ALT_PARAMETERS, ALT_TOOL_CALL]
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
);

/**
 * Strip proprietary tool-call wrapper leakage from model content. Returns the
 * content unchanged when no leakage marker is present. Accepts undefined /
 * null (returns an empty string) for ergonomic use with optional fields.
 */
export function stripToolCallLeakage(content: string | undefined | null): string {
  if (!content) return "";
  const at = content.search(LEAK_START);
  if (at < 0) return content;
  return content.slice(0, at).trimEnd();
}