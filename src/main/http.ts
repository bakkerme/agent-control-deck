import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Store } from "./store";
import type { Inbox } from "./inbox";
import { normalize } from "./providers";
import { DEFAULT_HTTP_PORT, hookEvents, neutralHookResponse, sourceToken, type HookConnection } from "./setup";

interface Context { store: Store; inbox: Inbox; root: string; demo: boolean }
export function receiverOptions(env: NodeJS.ProcessEnv = process.env) {
  const host = env.ACD_HTTP_HOST ?? "127.0.0.1";
  const port = Number(env.ACD_HTTP_PORT ?? DEFAULT_HTTP_PORT);
  if (!isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("ACD_HTTP_HOST must be an IP address and ACD_HTTP_PORT must be between 0 and 65535");
  return { host, port };
}

export class HookReceiver {
  private active = 0;
  readonly server = createServer((req, res) => this.receive(req, res));
  constructor(private context: () => Context) {
    this.server.requestTimeout = 3000;
    this.server.headersTimeout = 3000;
    this.server.keepAliveTimeout = 1000;
    this.server.maxConnections = 16;
  }
  async listen(options = receiverOptions()): Promise<HookConnection> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(options.port, options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Could not determine HTTP receiver address");
    // Wildcard listening is explicitly opt-in, but native hooks still use loopback.
    const host = options.host === "0.0.0.0" ? "127.0.0.1" : options.host === "::" ? "::1" : options.host;
    return { url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}` };
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
      this.server.closeAllConnections();
    });
  }
  private receive(req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number, body = "") => {
      if (res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close" });
      res.end(body);
      if (status >= 400) res.once("finish", () => req.destroy());
    };
    // No browser clients, redirects, CORS, or command/control routes.
    if (req.method !== "POST") return reply(405);
    if (req.headers.origin || req.headers["sec-fetch-site"]) return reply(403);
    if (this.active >= 8) return reply(503);
    const match = /^\/hooks\/([a-zA-Z0-9-]{1,200})\/([a-zA-Z]+)$/.exec(req.url ?? "");
    if (!match) return reply(404);
    const [, sourceId, event] = match;
    const ctx = this.context();
    if (ctx.demo) return reply(503);
    let source;
    try { source = ctx.store.source(sourceId); } catch { return reply(404); }
    if (!hookEvents(source.provider).includes(event)) return reply(404);
    try {
      const expected = Buffer.from(`Bearer ${sourceToken(ctx.root, sourceId)}`);
      const supplied = Buffer.from(req.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401);
    } catch { return reply(503); }
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return reply(415);
    if (Number(req.headers["content-length"] ?? 0) > 262144) return reply(413);
    this.active++;
    let released = false;
    const release = () => { if (!released) { released = true; this.active--; } };
    req.once("close", release);
    req.on("error", () => reply(400));
    req.setTimeout(3000, () => { reply(408); req.destroy(); });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 262144) { reply(413); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      release();
      if (res.writableEnded) return;
      const current = this.context();
      if (current.root !== ctx.root || current.demo) return reply(503);
      let payload: Record<string, unknown>;
      let envelope;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400);
        payload = parsed as Record<string, unknown>;
        if (payload.hook_event_name !== event || !normalize(source, payload)) return reply(400);
        const eventId = req.headers["x-deck-event-id"] ?? randomUUID();
        if (typeof eventId !== "string" || !/^[a-zA-Z0-9-]{1,200}$/.test(eventId)) return reply(400);
        envelope = { version: 1, eventId, observedAt: new Date().toISOString(), payload };
        if (Buffer.byteLength(JSON.stringify(envelope)) > 262144) return reply(413);
      } catch { return reply(400); }
      try {
        // Acknowledge only after the atomic queue write. Database failure leaves
        // the file available for retry; pause retains it as well.
        ctx.inbox.enqueue(sourceId, envelope);
      } catch {
        try { ctx.store.sourceError(sourceId, "HTTP event could not be queued. Check disk space, permissions, and inbox capacity."); } catch { /* Storage is already unavailable. */ }
        return reply(503);
      }
      // Fixed neutral responses only. Provider/user content never enters output.
      reply(200, neutralHookResponse(source.provider, event));
    });
  }
}
