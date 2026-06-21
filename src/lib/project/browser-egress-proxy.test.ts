import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserEgressProxy } from "./browser-egress-proxy";
import type { DnsLookup } from "./network-policy";

const PUBLIC_IP = "93.184.216.34";

function publicLookup(address = PUBLIC_IP): DnsLookup {
  return vi.fn(async () => [{ address, family: 4 }]) as unknown as DnsLookup;
}

function privateLookup(): DnsLookup {
  return vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as DnsLookup;
}

function startEchoUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("data", (data) => socket.write(data));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function startHttpUpup(): Promise<{
  port: number;
  close: () => Promise<void>;
  seen: { host: string; url: string };
}> {
  const seen = { host: "", url: "" };
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (data) => {
        buf += data.toString();
        if (buf.includes("\r\n\r\n")) {
          const head = buf.split("\r\n\r\n")[0];
          const firstLine = head.split("\r\n")[0];
          const hostLine = head.split("\r\n").find((l) => l.toLowerCase().startsWith("host:"));
          seen.url = firstLine.split(" ")[1];
          seen.host = hostLine ? hostLine.split(":").slice(1).join(":").trim() : "";
          socket.write(
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
          );
          socket.end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
        seen,
      });
    });
  });
}

function makeProxy(opts: {
  lookup?: DnsLookup;
  connectTarget?: (address: string, port: number) => Promise<net.Socket>;
  maxBytes?: number;
  maxConnections?: number;
}) {
  const upstreamPort = opts.connectTarget ? 0 : -1;
  void upstreamPort;
  return new BrowserEgressProxy({
    lookup: opts.lookup ?? publicLookup(),
    connectTarget: opts.connectTarget,
    maxBytes: opts.maxBytes,
    maxConnections: opts.maxConnections,
  });
}

describe("BrowserEgressProxy/HTTP absolute requests", () => {
  let upstream: { port: number; close: () => Promise<void>; seen: { host: string; url: string } };

  beforeEach(async () => {
    upstream = await startHttpUpup();
  });
  afterEach(async () => {
    await upstream.close();
  });

  function connectToUpstream(address: string, port: number): Promise<net.Socket> {
    // Transport is faked to the local upstream; the pinned address is recorded.
    void address;
    void port;
    return new Promise((resolve, reject) => {
      const socket = net.connect(upstream.port, "127.0.0.1");
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  it("forwards to the pinned public address and preserves the Host header", async () => {
    const connectTarget = vi.fn(connectToUpstream);
    const proxy = makeProxy({ connectTarget });
    const { port, close } = await proxy.start();
    try {
      const client = net.connect(port, "127.0.0.1");
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      client.write("GET http://target.test/path HTTP/1.1\r\nHost: target.test\r\n\r\n");
      const body = await new Promise<string>((resolve) => {
        let buf = "";
        client.on("data", (d) => {
          buf += d.toString();
          if (buf.endsWith("hello")) resolve(buf);
        });
        client.on("end", () => resolve(buf));
      });
      expect(body).toContain("hello");
      expect(upstream.seen.host).toBe("target.test");
      expect(upstream.seen.url).toBe("http://target.test/path");
      expect(connectTarget).toHaveBeenCalledWith(PUBLIC_IP, 80);
      client.destroy();
    } finally {
      await close();
    }
  });

  it("rejects an absolute request to a private DNS target with a sanitized response", async () => {
    const connectTarget = vi.fn(connectToUpstream);
    const proxy = makeProxy({ lookup: privateLookup(), connectTarget });
    const { port, close } = await proxy.start();
    try {
      const client = net.connect(port, "127.0.0.1");
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      client.write("GET http://internal.test/path HTTP/1.1\r\nHost: internal.test\r\n\r\n");
      const body = await new Promise<string>((resolve) => {
        let buf = "";
        client.on("data", (d) => {
          buf += d.toString();
          if (buf.includes("\r\n\r\n")) resolve(buf);
        });
        client.on("end", () => resolve(buf));
      });
      expect(body).toMatch(/403/);
      expect(body).not.toContain("127.0.0.1");
      expect(connectTarget).not.toHaveBeenCalled();
      client.destroy();
    } finally {
      await close();
    }
  });
});

describe("BrowserEgressProxy/CONNECT tunnels", () => {
  let upstream: { port: number; close: () => Promise<void> };

  beforeEach(async () => {
    upstream = await startEchoUpstream();
  });
  afterEach(async () => {
    await upstream.close();
  });

  function connectToUpstream(address: string, port: number): Promise<net.Socket> {
    void address;
    void port;
    return new Promise((resolve, reject) => {
      const socket = net.connect(upstream.port, "127.0.0.1");
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  async function openConnect(
    port: number,
    authority: string,
  ): Promise<{ client: net.Socket; status: string; tunneled: (msg: string) => Promise<string> }> {
    const client = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const status = await new Promise<string>((resolve) => {
      let buf = "";
      const onData = (d: Buffer) => {
        buf += d.toString();
        if (buf.includes("\r\n\r\n")) {
          client.off("data", onData);
          resolve(buf.split("\r\n")[0]);
        }
      };
      client.on("data", onData);
    });
    const tunneled = (msg: string) =>
      new Promise<string>((resolve) => {
        const onData = (d: Buffer) => {
          client.off("data", onData);
          resolve(d.toString());
        };
        client.on("data", onData);
        client.write(msg);
      });
    return { client, status, tunneled };
  }

  it("tunnels to the pinned public address on port 443", async () => {
    const connectTarget = vi.fn(connectToUpstream);
    const proxy = makeProxy({ connectTarget });
    const { port, close } = await proxy.start();
    try {
      const { status, tunneled, client } = await openConnect(port, "target.test:443");
      expect(status).toBe("HTTP/1.1 200 Connection established");
      const echoed = await tunneled("ping");
      expect(echoed).toBe("ping");
      expect(connectTarget).toHaveBeenCalledWith(PUBLIC_IP, 443);
      client.destroy();
    } finally {
      await close();
    }
  });

  it("allows port 80", async () => {
    const connectTarget = vi.fn(connectToUpstream);
    const proxy = makeProxy({ connectTarget });
    const { port, close } = await proxy.start();
    try {
      const { status, client } = await openConnect(port, "target.test:80");
      expect(status).toBe("HTTP/1.1 200 Connection established");
      client.destroy();
    } finally {
      await close();
    }
  });

  it("rejects non-80/443 ports with 403", async () => {
    const connectTarget = vi.fn(connectToUpstream);
    const proxy = makeProxy({ connectTarget });
    const { port, close } = await proxy.start();
    try {
      const { status, client } = await openConnect(port, "target.test:22");
      expect(status).toMatch(/403/);
      expect(connectTarget).not.toHaveBeenCalled();
      client.destroy();
    } finally {
      await close();
    }
  });

  it("rejects a CONNECT to a private DNS target with 403 and no address leak", async () => {
    const connectTarget = vi.fn(connectToUpstream);
    const proxy = makeProxy({ lookup: privateLookup(), connectTarget });
    const { port, close } = await proxy.start();
    try {
      const { status, client } = await openConnect(port, "internal.test:443");
      expect(status).toMatch(/403/);
      expect(connectTarget).not.toHaveBeenCalled();
      client.destroy();
    } finally {
      await close();
    }
  });
});

describe("BrowserEgressProxy/limits and cleanup", () => {
  let upstream: { port: number; close: () => Promise<void> };

  beforeEach(async () => {
    upstream = await startEchoUpstream();
  });
  afterEach(async () => {
    await upstream.close();
  });

  function connectToUpstream(address: string, port: number): Promise<net.Socket> {
    void address;
    void port;
    return new Promise((resolve, reject) => {
      const socket = net.connect(upstream.port, "127.0.0.1");
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  it("destroys a tunnel that exceeds the byte limit", async () => {
    const connectTarget = vi.fn(connectToUpstream);
    const proxy = makeProxy({ connectTarget, maxBytes: 8 });
    const { port, close } = await proxy.start();
    try {
      const client = net.connect(port, "127.0.0.1");
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      client.write("CONNECT target.test:443 HTTP/1.1\r\nHost: target.test:443\r\n\r\n");
      await new Promise<void>((resolve) => {
        const onData = (d: Buffer) => {
          if (d.toString().includes("\r\n\r\n")) {
            client.off("data", onData);
            resolve();
          }
        };
        client.on("data", onData);
      });
      const ended = new Promise<boolean>((resolve) => {
        client.on("close", () => resolve(true));
      });
      client.write("1234567890abcdef"); // exceeds 8 bytes
      expect(await ended).toBe(true);
    } finally {
      await close();
    }
  });

  it("rejects connections beyond the concurrency limit", async () => {
    // Pause the upstream so the first tunnel stays open.
    const holdingServer = net.createServer((socket) => {
      socket.on("data", () => {
        /* hold open, never respond */
      });
    });
    const holdPort = await new Promise<number>((resolve) => {
      holdingServer.listen(0, "127.0.0.1", () =>
        resolve((holdingServer.address() as net.AddressInfo).port),
      );
    });

    const connectTarget = vi.fn(async () => net.connect(holdPort, "127.0.0.1"));
    const proxy = makeProxy({ connectTarget, maxConnections: 1 });
    const { port, close } = await proxy.start();
    try {
      const a = net.connect(port, "127.0.0.1");
      await new Promise<void>((resolve) => a.once("connect", () => resolve()));
      a.write("CONNECT target.test:443 HTTP/1.1\r\nHost: target.test:443\r\n\r\n");
      await new Promise<void>((resolve) => {
        a.on("data", (d) => {
          if (d.toString().includes("200")) resolve();
        });
      });

      const b = net.connect(port, "127.0.0.1");
      await new Promise<void>((resolve) => b.once("connect", () => resolve()));
      b.write("CONNECT target.test:443 HTTP/1.1\r\nHost: target.test:443\r\n\r\n");
      const status = await new Promise<string>((resolve) => {
        let buf = "";
        b.on("data", (d) => {
          buf += d.toString();
          if (buf.includes("\r\n\r\n")) resolve(buf.split("\r\n")[0]);
        });
      });
      expect(status).toMatch(/403|503/);
      a.destroy();
      b.destroy();
    } finally {
      await close();
      holdingServer.close();
    }
  });

  it("close() destroys all tracked sockets", async () => {
    const holdingServer = net.createServer((socket) => {
      socket.on("data", () => {});
    });
    const holdPort = await new Promise<number>((resolve) => {
      holdingServer.listen(0, "127.0.0.1", () =>
        resolve((holdingServer.address() as net.AddressInfo).port),
      );
    });

    const connectTarget = vi.fn(async () => net.connect(holdPort, "127.0.0.1"));
    const proxy = makeProxy({ connectTarget });
    const { port, close } = await proxy.start();
    const client = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write("CONNECT target.test:443 HTTP/1.1\r\nHost: target.test:443\r\n\r\n");
    await new Promise<void>((resolve) => {
      client.on("data", (d) => {
        if (d.toString().includes("200")) resolve();
      });
    });

    const closed = new Promise<boolean>((resolve) => client.on("close", () => resolve(true)));
    await close();
    expect(await closed).toBe(true);
    holdingServer.close();
  });
});