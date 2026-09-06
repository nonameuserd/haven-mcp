import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { HavenGatewayBridge, type HavenGatewayBridgeOptions } from "./gateway.js";
import { createHavenMcpServer } from "./server.js";
import { GatewaySessionStore, type StoredGatewaySession } from "./session.js";

export type HavenMcpDurableSessionStore = {
  load: (mcpSessionId: string) => Promise<StoredGatewaySession | null>;
  save: (mcpSessionId: string, session: StoredGatewaySession) => Promise<void>;
  clear: (mcpSessionId: string) => Promise<void>;
};

export type HavenMcpHttpHandlerOptions = HavenGatewayBridgeOptions & {
  /** Exact MCP path (default `/mcp`). */
  route?: string;
  /**
   * Prefer JSON responses over SSE streams (simpler for many remote hosts).
   * Default true for remote HTTP.
   */
  enableJsonResponse?: boolean;
  /**
   * Durable Haven gateway token store (DO storage / KV).
   * Required for production Workers so tokens survive isolate eviction.
   */
  durable?: HavenMcpDurableSessionStore;
};

type SessionSlot = {
  readonly sessionId: string;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: Server;
  readonly bridge: HavenGatewayBridge;
};

const corsHeaders = (req: Request): Record<string, string> => {
  const origin = req.headers.get("Origin");
  const allowOrigin = origin && origin !== "null" ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, MCP-Session-Id, mcp-session-id, MCP-Protocol-Version, Last-Event-ID, X-Haven-Mcp-Slot-Id",
    "Access-Control-Expose-Headers": "MCP-Session-Id, mcp-session-id",
    "Access-Control-Max-Age": "86400",
  };
};

const withCors = (req: Request, res: Response): Response => {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};

/**
 * MCP Streamable HTTP requires Accept to list both application/json and
 * text/event-stream. Some clients (curl, thin wrappers) omit it on
 * notifications/initialized. Fill the gap so the SDK does not 406.
 */
const ensureMcpAccept = (request: Request): Request => {
  const accept = request.headers.get("Accept") ?? request.headers.get("accept") ?? "";
  const hasJson = accept.includes("application/json");
  const hasSse = accept.includes("text/event-stream");
  if (hasJson && hasSse) return request;

  const parts = new Set(
    accept
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
  parts.add("application/json");
  parts.add("text/event-stream");
  const headers = new Headers(request.headers);
  headers.set("Accept", [...parts].join(", "));
  return new Request(request, { headers });
};

/**
 * Streamable HTTP MCP handler (web-standard Request/Response).
 *
 * Holds one MCP protocol session per `mcp-session-id`. Haven `hvs_…` tokens
 * stay in the adapter store (and optional durable backend), never in tool results.
 *
 * Used by the local Node HTTP entry and by the Cloudflare Worker Durable Object.
 */
export const createHavenMcpHttpHandler = (
  opts: HavenMcpHttpHandlerOptions = {},
): {
  fetch: (request: Request) => Promise<Response>;
  sessionCount: () => number;
  close: () => Promise<void>;
} => {
  const route = opts.route ?? "/mcp";
  const enableJsonResponse = opts.enableJsonResponse ?? true;
  const sessions = new Map<string, SessionSlot>();

  const createSlot = async (sessionId: string): Promise<SessionSlot> => {
    const durable = opts.durable;
    const store =
      opts.store ??
      new GatewaySessionStore(
        durable
          ? {
              onSet: (session) => durable.save(sessionId, session),
              onClear: () => durable.clear(sessionId),
            }
          : {},
      );

    if (durable && !opts.store) {
      const existing = await durable.load(sessionId);
      if (existing) store.hydrate(existing);
    }

    const bridge = new HavenGatewayBridge({
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      store,
    });

    const { server } = createHavenMcpServer({ bridge });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse,
      onsessionclosed: async (closedId) => {
        const slot = sessions.get(closedId);
        if (slot) {
          sessions.delete(closedId);
          try {
            await slot.server.close();
          } catch {
            /* ignore */
          }
        }
        if (durable) await durable.clear(closedId);
      },
    });
    await server.connect(transport);
    const slot: SessionSlot = { sessionId, transport, server, bridge };
    sessions.set(sessionId, slot);
    return slot;
  };

  const fetchHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204 }));
    }

    if (url.pathname === "/health" || url.pathname === `${route}/health`) {
      return withCors(
        request,
        Response.json({
          ok: true,
          name: "haven-mcp",
          transport: "streamable-http",
          sessions: sessions.size,
        }),
      );
    }

    if (url.pathname !== route) {
      return withCors(request, new Response("Not Found", { status: 404 }));
    }

    const accepted = ensureMcpAccept(request);
    const existingId = accepted.headers.get("mcp-session-id");

    if (existingId) {
      let slot = sessions.get(existingId);
      if (!slot) {
        // Wake path: recreate transport for known session id (DO / cold isolate).
        slot = await createSlot(existingId);
      }
      const res = await slot.transport.handleRequest(accepted);
      return withCors(request, res);
    }

    // Initialize: mint (or accept Worker-routed) protocol session id.
    // `x-haven-mcp-slot-id` lets the Cloudflare Worker bind DO name === session id
    // without sending mcp-session-id on the initialize POST (protocol-correct).
    const routedSlot = accepted.headers.get("x-haven-mcp-slot-id")?.trim();
    const sessionId =
      routedSlot && routedSlot.length > 0 ? routedSlot : crypto.randomUUID();
    const slot = await createSlot(sessionId);

    // Strip routing header before the MCP transport sees the request.
    let mcpRequest = accepted;
    if (accepted.headers.has("x-haven-mcp-slot-id")) {
      const headersIn = new Headers(accepted.headers);
      headersIn.delete("x-haven-mcp-slot-id");
      mcpRequest = new Request(accepted, { headers: headersIn });
    }
    const res = await slot.transport.handleRequest(mcpRequest);
    const headers = new Headers(res.headers);
    if (!headers.get("mcp-session-id")) {
      headers.set("mcp-session-id", sessionId);
    }
    return withCors(
      request,
      new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      }),
    );
  };

  return {
    fetch: fetchHandler,
    sessionCount: () => sessions.size,
    close: async () => {
      for (const slot of sessions.values()) {
        try {
          await slot.transport.close();
        } catch {
          /* ignore */
        }
        try {
          await slot.server.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
    },
  };
};
