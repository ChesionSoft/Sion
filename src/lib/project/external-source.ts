import { createHash } from "node:crypto";
import type { ExternalSource } from "./types";

export function normalizeExternalUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.toString();
}

export function createExternalSource(
  input: Omit<ExternalSource, "id" | "domain"> & { domain?: string },
): ExternalSource {
  const url = normalizeExternalUrl(input.url);
  const id = createHash("sha256")
    .update(`${input.kind}:${url}`)
    .digest("hex")
    .slice(0, 20);
  return {
    kind: input.kind,
    url,
    title: input.title,
    domain: input.domain ?? new URL(url).hostname,
    snippet: input.snippet,
    retrievedAt: input.retrievedAt,
    id,
  };
}

export function dedupeExternalSources(sources: ExternalSource[]): ExternalSource[] {
  const map = new Map<string, ExternalSource>();
  for (const source of sources) {
    const key = `${source.kind}:${source.url}`;
    if (!map.has(key)) map.set(key, source);
  }
  return [...map.values()];
}