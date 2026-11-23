import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
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
  protocolVersion?: string;
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

/** Read the SDK's finite initialize response in JSON or SSE mode. */
const initializedProtocol = async (response: Response): Promise<string | undefined> => {
  const text = await response.text();
  const payloads = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [text];
  for (const value of payloads) {
    try {
      const payload = JSON.parse(value) as { result?: { protocolVersion?: unknown } };
      if (typeof payload.result?.protocolVersion === "string")
        return payload.result.protocolVersion;
    } catch {
      /* Ignore non-JSON SSE control lines. */
    }
  }
  return undefined;
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

  const creating = new Map<string, Promise<SessionSlot | null>>();

  const createSlot = async (
    sessionId: string,
    request: Request,
    requireStored: boolean,
  ): Promise<SessionSlot | null> => {
    const durable = opts.durable;
    const existing = durable && !opts.store ? await durable.load(sessionId) : null;
    const liveStored =
      existing &&
      Date.parse(existing.expiresAt) > Date.now() &&
      (existing.sessionToken || existing.resumeToken);
    if (existing && !liveStored && durable) await durable.clear(sessionId);
    // A caller-supplied unknown or expired id must not allocate a protocol slot.
    if (requireStored && !liveStored) return null;
    let slot: SessionSlot;
    const store =
      opts.store ??
      new GatewaySessionStore(
        durable
          ? {
              onSet: (session) =>
                durable.save(sessionId, {
                  ...session,
                  protocolVersion: slot.protocolVersion,
                }),
              onClear: () => durable.clear(sessionId),
            }
          : {},
      );

    if (liveStored && existing) store.hydrate(existing);

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
        if (slot) {
          slot.bridge.store.clear();
          await slot.bridge.store.flush();
        } else if (durable) await durable.clear(closedId);
      },
    });
    await server.connect(transport);
    slot = {
      sessionId,
      transport,
      server,
      bridge,
      protocolVersion: existing?.protocolVersion,
    };
    if (requireStored) {
      const body =
        request.method === "POST"
          ? ((await request
              .clone()
              .json()
              .catch(() => null)) as { method?: string } | null)
          : null;
      if (body?.method !== "initialize") {
        // Restore the tools-only server through the SDK's public lifecycle API.
        // The old MCP id is the bearer, and the durable credential lease is the gate.
        // No Gateway session is minted, and no SDK private fields are modified.
        const restored = await transport.handleRequest(
          new Request(request.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "haven-restore",
              method: "initialize",
              params: {
                protocolVersion:
                  existing?.protocolVersion ??
                  request.headers.get("mcp-protocol-version") ??
                  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "haven-restored-tools-client", version: "1" },
              },
            }),
          }),
        );
        const protocolVersion = await initializedProtocol(restored);
        if (!restored.ok || !protocolVersion) {
          await server.close();
          throw new Error(
            "Unable to restore MCP transport; durable credentials retained.",
          );
        }
        slot.protocolVersion = protocolVersion;
        await transport.handleRequest(
          new Request(request.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "mcp-session-id": sessionId,
            },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          }),
        );
      }
    }
    sessions.set(sessionId, slot);
    return slot;
  };

  const getSlot = async (
    id: string,
    request: Request,
    requireStored: boolean,
  ): Promise<SessionSlot | null> => {
    const slot = sessions.get(id);
    if (slot) return slot;
    let pending = creating.get(id);
    if (!pending) {
      pending = createSlot(id, request, requireStored);
      creating.set(id, pending);
    }
    try {
      return await pending;
    } finally {
      if (creating.get(id) === pending) creating.delete(id);
    }
  };

  const handle = async (slot: SessionSlot, request: Request): Promise<Response> => {
    const response = await slot.transport.handleRequest(request);
    if (!slot.protocolVersion && response.ok) {
      slot.protocolVersion = await initializedProtocol(response.clone());
    }
    return response;
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
      const slot = await getSlot(existingId, accepted, true);
      if (!slot)
        return withCors(
          request,
          Response.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32001,
                message:
                  "MCP session not found or expired. A handle alone cannot recover it.",
              },
            },
            { status: 404 },
          ),
        );
      const res = await handle(slot, accepted);
      return withCors(request, res);
    }

    // Initialize: issue (or accept Worker-routed) protocol session id.
    // `x-haven-mcp-slot-id` lets the Cloudflare Worker bind DO name === session id
    // without sending mcp-session-id on the initialize POST (protocol-correct).
    const routedSlot = accepted.headers.get("x-haven-mcp-slot-id")?.trim();
    const sessionId =
      routedSlot && routedSlot.length > 0 ? routedSlot : crypto.randomUUID();
    const slot = (await getSlot(sessionId, accepted, false))!;

    // Strip routing header before the MCP transport sees the request.
    let mcpRequest = accepted;
    if (accepted.headers.has("x-haven-mcp-slot-id")) {
      const headersIn = new Headers(accepted.headers);
      headersIn.delete("x-haven-mcp-slot-id");
      mcpRequest = new Request(accepted, { headers: headersIn });
    }
    const res = await handle(slot, mcpRequest);
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
