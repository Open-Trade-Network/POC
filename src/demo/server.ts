import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HostedTradeNetwork } from "../network.js";
import { DemoSession, type DemoSnapshot } from "./orchestrator.js";
import { SellerErpMock } from "./seller-erp.js";

const STATIC_ROOT = fileURLToPath(new URL("../../../ui/dist", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface DemoServerOptions {
  host?: string;
  port?: number;
  stepDelayMs?: number;
  networkPort?: number;
}

/**
 * Demo application server. Hosts three planes on one loopback port:
 *   /            -> the compiled UI (ui/dist)
 *   /api/demo/*  -> demo state, start/reset, and a server-sent event stream
 *   /erp/*       -> the seller's mocked ERP (Zoho Books-shaped endpoints)
 * The real HostedTradeNetwork sandbox runs alongside on its own port and is
 * only ever contacted over HTTP by the participant gateways.
 */
export class DemoServer {
  readonly host: string;
  port: number;
  private server: Server | undefined;
  private network: HostedTradeNetwork;
  private erp: SellerErpMock;
  private session: DemoSession;
  private readonly sseClients = new Set<ServerResponse>();
  private readonly stepDelayMs: number;
  private readonly networkPort: number;

  constructor(options: DemoServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8080;
    this.stepDelayMs = options.stepDelayMs ?? 450;
    this.networkPort = options.networkPort ?? 0;
    this.network = new HostedTradeNetwork({ host: "127.0.0.1", port: this.networkPort });
    this.erp = new SellerErpMock();
    this.session = this.createSession();
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  get erpBaseUrl(): string {
    return `${this.url}/erp`;
  }

  get networkUrl(): string {
    return this.network.url;
  }

  /** Runs the full demo flow and resolves with the final snapshot. */
  async runDemo(): Promise<DemoSnapshot> {
    if (this.session.state.phase === "complete" || this.session.state.phase === "error") {
      await this.reset();
    }
    return this.session.run();
  }

  /** Rebuilds the network, ERP mock and session so the demo starts clean. */
  async reset(): Promise<void> {
    await this.network.stop();
    this.network = new HostedTradeNetwork({ host: "127.0.0.1", port: this.networkPort });
    await this.network.start();
    this.erp = new SellerErpMock();
    this.session = this.createSession();
    this.broadcast(this.session.state);
  }

  private createSession(): DemoSession {
    const session = new DemoSession({
      network: this.network,
      erpBaseUrl: () => this.erpBaseUrl,
      stepDelayMs: this.stepDelayMs,
    });
    session.subscribe((snapshot) => this.broadcast(snapshot));
    return session;
  }

  private broadcast(snapshot: unknown): void {
    const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of this.sseClients) client.write(frame);
  }

  async start(): Promise<this> {
    await this.network.start();
    if (this.server) return this;
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => {
        const info = this.server!.address();
        if (info && typeof info !== "string") this.port = info.port;
        resolve();
      });
    });
    return this;
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((error) => (error ? reject(error) : resolve()));
      });
      this.server = undefined;
    }
    await this.network.stop();
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(body));
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.url);

      if (this.erp.handle(request, response)) return;

      if (request.method === "GET" && url.pathname === "/api/demo/stream") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write(`data: ${JSON.stringify(this.session.state)}\n\n`);
        this.sseClients.add(response);
        request.on("close", () => this.sseClients.delete(response));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/demo/state") {
        this.sendJson(response, 200, { ...this.session.state, erp: { status: this.erp.currentStatus } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/demo/start") {
        if (this.session.state.phase === "running") {
          this.sendJson(response, 409, { error: "Demo is already running" });
          return;
        }
        if (this.session.state.phase === "complete" || this.session.state.phase === "error") {
          await this.reset();
        }
        this.sendJson(response, 202, { ok: true });
        void this.session.run();
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/demo/reset") {
        await this.reset();
        this.sendJson(response, 200, this.session.state);
        return;
      }

      if (request.method === "GET") {
        await this.serveStatic(url.pathname, response);
        return;
      }

      this.sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      console.error("Demo request failed", error);
      if (!response.headersSent) {
        this.sendJson(response, 500, { error: "Internal server error" });
      } else {
        response.end();
      }
    }
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const requested = pathname === "/" ? "/index.html" : pathname;
    const resolved = normalize(join(STATIC_ROOT, requested));
    if (!resolved.startsWith(normalize(STATIC_ROOT))) {
      this.sendJson(response, 403, { error: "Forbidden" });
      return;
    }
    try {
      const contents = await readFile(resolved);
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(contents);
    } catch {
      // SPA fallback
      try {
        const contents = await readFile(join(STATIC_ROOT, "index.html"));
        response.writeHead(200, {
          "Content-Type": CONTENT_TYPES[".html"]!,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(contents);
      } catch {
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("UI has not been built yet. Run: npm run build:ui");
      }
    }
  }
}

async function main(): Promise<void> {
  const server = new DemoServer({
    host: process.env.DEMO_HOST ?? "127.0.0.1",
    port: Number(process.env.DEMO_PORT ?? 8080),
    ...(process.env.DEMO_STEP_DELAY_MS ? { stepDelayMs: Number(process.env.DEMO_STEP_DELAY_MS) } : {}),
  });
  await server.start();
  console.log(`Open Trade Network demo: ${server.url}`);
  console.log(`Sandbox network:         ${server.networkUrl}`);

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
