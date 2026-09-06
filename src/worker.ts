/**
 * Cloudflare Worker: remote Streamable HTTP MCP over Haven Gateway.
 *
 * Architecture:
 * - Worker fetch routes `/mcp` to a Durable Object keyed by MCP session id
 * - DO holds the MCP transport + HavenGatewayBridge for that protocol session
 * - Haven `hvs_…` tokens persist in DO storage (survive hibernation / isolate moves)
 * - Tool results never include tokens or attestation signatures
 *
 * Env:
 * - HAVEN_BASE_URL (var) — Gateway origin, e.g. https://haven.chitmark.com
 * - HAVEN_MCP_SESSION (Durable Object binding)
 */

import { createHavenMcpHttpHandler } from "./http.js";
import type { StoredGatewaySession } from "./session.js";

/**
 * Structural DO binding types. Avoid importing `@cloudflare/workers-types` here:
 * that mixes CF Headers with DOM Headers (getSetCookie) under the Node tsconfig/IDE.
 */
type HavenDoStorage = {
  get: <T>(key: string) => Promise<T | undefined>;
  put: <T>(key: string, value: T) => Promise<void>;
  delete: (key: string) => Promise<boolean | void>;
};

type HavenDoState = {
  storage: HavenDoStorage;
};

type HavenDoNamespace = {
  idFromName: (name: string) => { toString(): string };
  get: (id: { toString(): string }) => { fetch: (request: Request) => Promise<Response> };
};

export type HavenMcpWorkerEnv = {
  HAVEN_BASE_URL: string;
  HAVEN_MCP_SESSION: HavenDoNamespace;
};

const HAVEN_SESSION_KEY = "haven_gateway_session";

/**
 * One Durable Object instance per MCP protocol session.
 * Sticky across requests; storage backs Haven gateway tokens.
 */
export class HavenMcpSession {
  private handler: ReturnType<typeof createHavenMcpHttpHandler> | null = null;

  constructor(
    private readonly ctx: HavenDoState,
    private readonly env: HavenMcpWorkerEnv,
  ) {}

  private getHandler(): ReturnType<typeof createHavenMcpHttpHandler> {
    if (this.handler) return this.handler;
    const storage = this.ctx.storage;
    this.handler = createHavenMcpHttpHandler({
      baseUrl: this.env.HAVEN_BASE_URL || "https://haven.chitmark.com",
      enableJsonResponse: true,
      durable: {
        load: async () => {
          const row = await storage.get<StoredGatewaySession>(HAVEN_SESSION_KEY);
          return row ?? null;
        },
        save: async (_mcpSessionId, session) => {
          await storage.put(HAVEN_SESSION_KEY, session);
        },
        clear: async () => {
          await storage.delete(HAVEN_SESSION_KEY);
        },
      },
    });
    return this.handler;
  }

  async fetch(request: Request): Promise<Response> {
    return this.getHandler().fetch(request);
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Route MCP traffic to a Durable Object named by the MCP session id.
 * New sessions mint an id before the first initialize POST.
 */
export default {
  async fetch(request: Request, env: HavenMcpWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        name: "haven-mcp",
        transport: "streamable-http",
        havenBaseUrl: env.HAVEN_BASE_URL || "https://haven.chitmark.com",
        mcp: "/mcp",
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Accept, MCP-Session-Id, mcp-session-id, MCP-Protocol-Version, Last-Event-ID, X-Haven-Mcp-Slot-Id",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    let sessionId = request.headers.get("mcp-session-id");
    const isNew = !sessionId;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
    }

    const id = env.HAVEN_MCP_SESSION.idFromName(sessionId);
    const stub = env.HAVEN_MCP_SESSION.get(id);

    const headers = new Headers(request.headers);
    if (isNew) {
      // Do not set mcp-session-id on initialize; pass slot id for DO binding only.
      headers.set("x-haven-mcp-slot-id", sessionId);
    }

    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    });

    const response = await stub.fetch(forwarded);
    const outHeaders = new Headers(response.headers);
    if (!outHeaders.get("mcp-session-id")) {
      outHeaders.set("mcp-session-id", sessionId);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  },
};
