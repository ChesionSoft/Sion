import ipaddr from "ipaddr.js";

/**
 * Shared public-network policy used by both the URL Reader and the browser
 * egress path. Every network connection in this codebase resolves through
 * {@link resolvePublicTarget} and connects to the pinned address it returns,
 * so a single unsafe DNS answer rejects the whole target.
 */

export type NetworkPolicyErrorCode = "blocked_address" | "invalid_url" | "fetch_failed";

export class NetworkPolicyError extends Error {
  constructor(public readonly code: NetworkPolicyErrorCode, message: string) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

export type DnsAnswer = { address: string; family: number };
export type DnsLookup = (hostname: string) => Promise<DnsAnswer[]>;

/**
 * True iff `address` parses as a unicast public IP. IPv4-mapped IPv6 addresses
 * are normalized to IPv4 first. Malformed input returns false rather than
 * throwing — callers that need a throw should use {@link resolvePublicTarget}.
 */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === "unicast";
}

/**
 * Parse and validate a request URL: must be http(s) and must not carry
 * credentials. Returns the parsed URL. Throws {@link NetworkPolicyError} with
 * code `invalid_url` on any violation.
 */
export function assertPublicHttpTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetworkPolicyError("invalid_url", "URL 格式不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NetworkPolicyError("invalid_url", "仅支持 http/https 协议");
  }
  if (url.username || url.password) {
    throw new NetworkPolicyError("invalid_url", "URL 不允许包含用户名密码");
  }
  return url;
}

async function defaultLookup(hostname: string): Promise<DnsAnswer[]> {
  const { promises } = await import("node:dns");
  const results = await promises.lookup(hostname, { all: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
}

/**
 * Resolve `hostname` and return one pinned public answer. Every DNS answer is
 * validated with {@link isPublicAddress} before any is used; a single unsafe
 * answer rejects the target with `blocked_address`. An empty answer set
 * rejects with `fetch_failed`. The first answer is returned as the pinned
 * connection target.
 */
export async function resolvePublicTarget(
  hostname: string,
  lookup: DnsLookup = defaultLookup,
): Promise<DnsAnswer> {
  const answers = await lookup(hostname);
  if (!answers.length) {
    throw new NetworkPolicyError("fetch_failed", "未能解析域名");
  }
  for (const answer of answers) {
    if (!isPublicAddress(answer.address)) {
      throw new NetworkPolicyError("blocked_address", "不允许访问非公网地址");
    }
  }
  return answers[0];
}