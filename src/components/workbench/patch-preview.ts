import { applyPartialPatchForPreview, applyPatches } from "@/lib/project/node-markdown-patcher";
import type { NodeMarkdownPatch, WorkflowNodeId } from "@/lib/project/types";

/**
 * Build an array of preview frames for animating the progressive application
 * of a set of patches.
 *
 * Frame 0 is the base markdown (before any patches). For each patch in order:
 *   - Prior patches are fully applied to form the base for this patch.
 *   - The current patch is revealed character by character (code-point-aware)
 *     using `applyPartialPatchForPreview`.
 *
 * The final frame equals `applyPatches(nodeId, baseMarkdown, allPatches).markdown`.
 *
 * @param nodeId           The workflow node id (used for schema lookup).
 * @param baseMarkdown     The starting markdown (before any patches).
 * @param patches          The ordered list of patches to animate.
 * @param charactersPerFrame Number of code-points to reveal per frame (default 2).
 * @returns                Array of markdown strings, one per frame.
 */
export function buildPatchPreviewFrames(
  nodeId: WorkflowNodeId,
  baseMarkdown: string,
  patches: NodeMarkdownPatch[],
  charactersPerFrame = 2,
): string[] {
  const frames: string[] = [];

  // Frame 0: base markdown before any patches
  frames.push(baseMarkdown);

  let currentBase = baseMarkdown;

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];

    // Determine the full length (in code points) of the animated content
    let fullLength: number;
    if (patch.patchKind === "append_bullet") {
      const text = patch.markdown.startsWith("- ")
        ? patch.markdown.slice(2)
        : patch.markdown;
      fullLength = [...text].length;
    } else {
      fullLength = [...patch.markdown].length;
    }

    // Build step positions (code-point-aware stepping)
    const steps: number[] = [];
    for (let k = 0; k < fullLength; k += charactersPerFrame) {
      steps.push(k);
    }
    // Always include the final position to produce the fully-applied patch
    if (fullLength > 0 && steps[steps.length - 1] !== fullLength) {
      steps.push(fullLength);
    }

    // Generate a frame for each step
    for (const visible of steps) {
      const frame = applyPartialPatchForPreview(nodeId, currentBase, patch, visible);
      frames.push(frame);
    }

    // Fully apply this patch for the next iteration's base
    const result = applyPatches(nodeId, currentBase, [patch]);
    currentBase = result.markdown;
  }

  return frames;
}