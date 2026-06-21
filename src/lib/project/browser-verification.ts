import { randomUUID } from "node:crypto";
import type { SearchEngineId } from "./types";

/**
 * In-memory store of scoped browser verification challenges. A challenge is
 * created when a search engine presents a captcha/consent page; it records the
 * server-held challenge URL plus ownership (project + session) and a 10-minute
 * expiry. The public `create` result never includes the URL — only
 * `verificationId` and `engine` — and `consume` requires all ownership fields
 * and deletes the record before returning the URL (single use).
 */

const TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;

type Challenge = {
  id: string;
  engine: SearchEngineId;
  challengeUrl: string;
  projectId: string;
  sessionId: string;
  expiresAt: number;
};

export type VerificationDeps = {
  now?: () => number;
  id?: () => string;
  maxEntries?: number;
};

export class BrowserVerificationStore {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly maxEntries: number;
  private readonly store = new Map<string, Challenge>();

  constructor(deps: VerificationDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.id = deps.id ?? (() => randomUUID());
    this.maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async create(input: {
    engine: SearchEngineId;
    challengeUrl: string;
    projectId: string;
    sessionId: string;
  }): Promise<{ verificationId: string; engine: SearchEngineId }> {
    this.purgeExpired();
    const id = this.id();
    const challenge: Challenge = {
      id,
      engine: input.engine,
      challengeUrl: input.challengeUrl,
      projectId: input.projectId,
      sessionId: input.sessionId,
      expiresAt: this.now() + TTL_MS,
    };
    this.store.set(id, challenge);
    this.enforceCap();
    return { verificationId: id, engine: input.engine };
  }

  async consume(input: {
    verificationId: string;
    projectId: string;
    sessionId: string;
  }): Promise<string> {
    this.purgeExpired();
    const challenge = this.store.get(input.verificationId);
    if (!challenge) throw new VerificationError("not_found");
    if (challenge.expiresAt <= this.now()) {
      this.store.delete(input.verificationId);
      throw new VerificationError("expired");
    }
    if (challenge.projectId !== input.projectId || challenge.sessionId !== input.sessionId) {
      throw new VerificationError("ownership_mismatch");
    }
    this.store.delete(input.verificationId);
    return challenge.challengeUrl;
  }

  async delete(verificationId: string): Promise<void> {
    this.store.delete(verificationId);
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [id, challenge] of this.store) {
      if (challenge.expiresAt <= now) this.store.delete(id);
    }
  }

  private enforceCap(): void {
    if (this.store.size <= this.maxEntries) return;
    // Evict oldest by expiry, then by insertion order.
    const entries = [...this.store.entries()].sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt,
    );
    const overflow = this.store.size - this.maxEntries;
    for (let i = 0; i < overflow; i++) {
      this.store.delete(entries[i][0]);
    }
  }
}

export class VerificationError extends Error {
  constructor(public readonly code: "not_found" | "expired" | "ownership_mismatch") {
    super(code);
    this.name = "VerificationError";
  }
}