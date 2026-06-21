import { describe, expect, it, vi } from "vitest";
import {
  assertPublicHttpTarget,
  isPublicAddress,
  NetworkPolicyError,
  resolvePublicTarget,
} from "./network-policy";

type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

function fakeLookup(answers: { address: string; family: number }[]): LookupFn {
  return vi.fn(async () => answers) as unknown as LookupFn;
}

describe("network-policy/isPublicAddress", () => {
  it.each([
    ["93.184.216.34", true],
    ["2606:2800:220:1:248:1893:25c8:1946", true],
    ["::ffff:93.184.216.34", true], // IPv4-mapped public IPv6
  ])("allows %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["::1", "ipv6 loopback"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["192.168.1.1", "RFC1918 192.168/16"],
    ["172.16.0.1", "RFC1918 172.16/12"],
    ["169.254.169.254", "link-local / metadata"],
    ["100.64.0.1", "CGNAT"],
    ["192.0.2.1", "documentation TEST-NET-1"],
    ["198.51.100.1", "documentation TEST-NET-2"],
    ["203.0.113.1", "documentation TEST-NET-3"],
    ["0.0.0.0", "unspecified"],
    ["255.255.255.255", "broadcast"],
    ["::ffff:127.0.0.1", "IPv4-mapped private"],
    ["fc00::1", "ULA IPv6"],
    ["fe80::1", "link-local IPv6"],
  ])("rejects %s (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("returns false for a malformed address instead of throwing", () => {
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });
});

describe("network-policy/assertPublicHttpTarget", () => {
  it("returns a parsed URL for http and https", () => {
    expect(assertPublicHttpTarget("https://example.com/path").hostname).toBe("example.com");
    expect(assertPublicHttpTarget("http://example.com/").hostname).toBe("example.com");
  });

  it.each(["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)"])(
    "rejects non-http(s) protocol %p",
    (url) => {
      expect(() => assertPublicHttpTarget(url)).toThrow(NetworkPolicyError);
      try {
        assertPublicHttpTarget(url);
      } catch (error) {
        expect((error as NetworkPolicyError).code).toBe("invalid_url");
      }
    },
  );

  it("rejects a malformed URL", () => {
    expect(() => assertPublicHttpTarget("not a url")).toThrow(NetworkPolicyError);
  });

  it("rejects embedded credentials", () => {
    expect(() => assertPublicHttpTarget("https://user:pass@example.com/")).toThrow(NetworkPolicyError);
    try {
      assertPublicHttpTarget("https://user:pass@example.com/");
    } catch (error) {
      expect((error as NetworkPolicyError).code).toBe("invalid_url");
    }
  });
});

describe("network-policy/resolvePublicTarget", () => {
  it("returns the first pinned public answer", async () => {
    const result = await resolvePublicTarget(
      "public.test",
      fakeLookup([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]),
    );
    expect(result).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("rejects a mixed public/private answer set as blocked_address", async () => {
    await expect(
      resolvePublicTarget(
        "mixed.test",
        fakeLookup([
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("rejects an all-private answer set as blocked_address", async () => {
    await expect(
      resolvePublicTarget("private.test", fakeLookup([{ address: "10.0.0.1", family: 4 }])),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("rejects an empty answer set as fetch_failed", async () => {
    await expect(
      resolvePublicTarget("empty.test", fakeLookup([])),
    ).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("uses the provided lookup for the hostname", async () => {
    const lookup = fakeLookup([{ address: "93.184.216.34", family: 4 }]);
    await resolvePublicTarget("example.com", lookup);
    expect(lookup).toHaveBeenCalledWith("example.com");
  });

  it("does not leak the resolved address in the blocked message", async () => {
    try {
      await resolvePublicTarget(
        "mixed.test",
        fakeLookup([
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]),
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkPolicyError);
      expect((error as NetworkPolicyError).message).not.toContain("127.0.0.1");
    }
  });
});