import http from "node:http";
import net from "node:net";
import { NetworkPolicyError, resolvePublicTarget, type DnsLookup } from "./network-policy";

/**
 * A loopback HTTP proxy that forces every browser egress connection through
 * {@link resolvePublicTarget} and connects to the pinned public address. All
 * traffic (HTTPS via CONNECT, HTTP via absolute-form requests) is validated; a
 * single private/reserved answer rejects the target. Bytes are accounted in
 * both directions, concurrency is bounded, and every socket is destroyed on
 * abort or proxy shutdown.
 */

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB per direction per tunnel
export const DEFAULT_MAX_CONNECTIONS = 8;

export type EgressProxyDeps = {
  lookup?: DnsLookup;
  /** Outbound connect to the pinned address. Defaults to a real TCP connect. */
  connectTarget?: (address: string, port: number) => Promise<net.Socket>;
  maxBytes?: number;
  maxConnections?: number;
  bindHost?: string;
};

export type EgressProxyHandle = {
  server: string;
  port: number;
  close(): Promise<void>;
};

function defaultConnectTarget(address: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, address);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const host = match[1].replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return null;
  return { host, port };
}

interface EgressSocket extends net.Socket {
  __egressActive?: boolean;
}

export class BrowserEgressProxy {
  private readonly lookup: DnsLookup;
  private readonly connectTarget: (address: string, port: number) => Promise<net.Socket>;
  private readonly maxBytes: number;
  private readonly maxConnections: number;
  private readonly bindHost: string;
  private server: http.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private activeConnections = 0;

  constructor(deps: EgressProxyDeps = {}) {
    this.lookup = deps.lookup ?? ((host: string) => resolvePublicTarget(host).then((a) => [a]));
    this.connectTarget = deps.connectTarget ?? defaultConnectTarget;
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxConnections = deps.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.bindHost = deps.bindHost ?? "127.0.0.1";
  }

  async start(): Promise<EgressProxyHandle> {
    const server = http.createServer((req, res) => this.handleHttpRequest(req, res));
    server.on("connect", (req, socket) => this.handleConnect(req, socket as net.Socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.bindHost, () => {
        const port = (server.address() as net.AddressInfo).port;
        server.off("error", reject);
        resolve({ server: `http://${this.bindHost}:${port}`, port, close: () => this.close() });
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.activeConnections = 0;
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private track(socket: net.Socket): void {
    const s = socket as EgressSocket;
    this.sockets.add(socket);
    socket.once("close", () => {
      this.sockets.delete(socket);
      if (s.__egressActive) {
        s.__egressActive = false;
        this.activeConnections = Math.max(0, this.activeConnections - 1);
      }
    });
  }

  private takeSlot(): boolean {
    if (this.activeConnections >= this.maxConnections) return false;
    this.activeConnections += 1;
    return true;
  }

  private async resolveTarget(host: string): Promise<{ address: string; family: number } | null> {
    try {
      return await resolvePublicTarget(host, this.lookup);
    } catch (error) {
      if (error instanceof NetworkPolicyError) return null;
      return null;
    }
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "";
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      res.writeHead(400, { "Content-Length": "0" });
      res.end();
      return;
    }
    if (target.protocol !== "http:") {
      res.writeHead(403, { "Content-Length": "0" });
      res.end();
      return;
    }
    const clientSocket = res.socket;
    if (!clientSocket) return;
    if (!this.takeSlot()) {
      res.writeHead(403, { "Content-Length": "0" });
      res.end();
      return;
    }
    (clientSocket as EgressSocket).__egressActive = true;
    this.track(clientSocket);

    const port = target.port ? Number(target.port) : 80;
    const pinned = await this.resolveTarget(target.hostname);
    if (!pinned) {
      this.writeRawError(clientSocket, 403);
      return;
    }
    let upstream: net.Socket;
    try {
      upstream = await this.connectTarget(pinned.address, port);
    } catch {
      this.writeRawError(clientSocket, 502);
      return;
    }
    this.track(upstream);

    // Reconstruct the request line + headers (absolute-form preserved) and
    // forward; preserve the original Host header.
    const headerLines = [`${req.method} ${rawUrl} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headerLines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
    req.pipe(upstream);
    // Forward the upstream's raw HTTP response verbatim to the client socket.
    this.pipeWithByteLimit(upstream, clientSocket, this.maxBytes);
    upstream.on("end", () => clientSocket.end());
  }

  private handleConnect(req: http.IncomingMessage, socket: net.Socket): void {
    this.track(socket);
    const parsed = parseAuthority(req.url ?? "");
    if (!parsed || (parsed.port !== 80 && parsed.port !== 443)) {
      this.writeConnectError(socket, 403);
      return;
    }
    if (!this.takeSlot()) {
      this.writeConnectError(socket, 403);
      return;
    }
    (socket as EgressSocket).__egressActive = true;

    void (async () => {
      const pinned = await this.resolveTarget(parsed.host);
      if (!pinned) {
        this.writeConnectError(socket, 403);
        return;
      }
      let upstream: net.Socket;
      try {
        upstream = await this.connectTarget(pinned.address, parsed.port);
      } catch {
        this.writeConnectError(socket, 502);
        return;
      }
      this.track(upstream);
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      this.pipeWithByteLimit(socket, upstream, this.maxBytes);
      this.pipeWithByteLimit(upstream, socket, this.maxBytes);
    })();
  }

  private pipeWithByteLimit(source: net.Socket, dest: net.Socket, limit: number): void {
    let total = 0;
    source.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        source.destroy();
        dest.destroy();
        return;
      }
      if (!dest.destroyed) dest.write(chunk);
    });
    source.on("end", () => dest.end());
    source.on("error", () => {
      source.destroy();
      dest.destroy();
    });
  }

  private writeConnectError(socket: net.Socket, status: number): void {
    const reason = status === 403 ? "Forbidden" : "Bad Gateway";
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\n\r\n`);
  }

  private writeRawError(socket: net.Socket, status: number): void {
    const reason = status === 403 ? "Forbidden" : "Bad Gateway";
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\n\r\n`);
  }
}