// Deterministic line diff used for regeneration candidates and review
// proposals. Pure and order-stable: the same inputs always produce the same
// sequence of same/remove/add lines.

export type DiffLine =
  | { kind: "same"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "add"; text: string };

/**
 * Computes a line-level diff between `before` and `after` using a longest common
 * subsequence so unchanged lines stay aligned and only real changes show.
 */
export const lineDiff = (before: string, after: string): DiffLine[] => {
  const beforeLines = before.length === 0 ? [] : before.split("\n");
  const afterLines = after.length === 0 ? [] : after.split("\n");
  const m = beforeLines.length;
  const n = afterLines.length;
  const lengths: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        beforeLines[i] === afterLines[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ kind: "same", text: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      result.push({ kind: "remove", text: beforeLines[i] });
      i += 1;
    } else {
      result.push({ kind: "add", text: afterLines[j] });
      j += 1;
    }
  }
  while (i < m) {
    result.push({ kind: "remove", text: beforeLines[i] });
    i += 1;
  }
  while (j < n) {
    result.push({ kind: "add", text: afterLines[j] });
    j += 1;
  }
  return result;
};

export type NumberedDiffLine = {
  kind: "same" | "remove" | "add";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

/**
 * Line diff with 1-based old/new line numbers for each row. `same` rows advance
 * both counters, `remove` only the old counter, `add` only the new counter.
 * Thin wrapper over `lineDiff`; the plain output is preserved.
 */
export const lineDiffWithNumbers = (before: string, after: string): NumberedDiffLine[] => {
  let oldLine = 1;
  let newLine = 1;
  return lineDiff(before, after).map((line) => {
    switch (line.kind) {
      case "same":
        return { ...line, oldLine: oldLine++, newLine: newLine++ };
      case "remove":
        return { ...line, oldLine: oldLine++, newLine: null };
      case "add":
        return { ...line, oldLine: null, newLine: newLine++ };
    }
  });
};