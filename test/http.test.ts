import { describe, expect, it, afterEach } from "vitest";
import { createHavenMcpHttpHandler } from "../src/http.js";
import { toolResultLeaksSecrets } from "../src/session.js";

type FetchCall = { url: string; init?: RequestInit };

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const mockGatewayFetch = (): { fetchImpl: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith("/api/agent-session") && init?.method === "POST") {
      return jsonResponse(200, {
        sessionId: "sess_http",
        sessionToken: "hvs_http_token_abcdefghijklmnop",
        handle: "http-bot",
        agentId: "agt_http",
        expiresAt: "2099-01-01T00:00:00.000Z",
        actions: ["look_around", "leave"],
        delivery: "header",
        signature: "must_not_leak",
      });
    }
    if (url.endsWith("/api/agent-session/look-around")) {
      return jsonResponse(200, []);
    }
    if (url.endsWith("/api/agent-session/leave")) {
      return jsonResponse(200, { ok: true, handle: "http-bot" });
    }
    return jsonResponse(404, { error: "NotFound", message: url });
  };
  return { fetchImpl, calls };
};

const mcpPost = async (
  handler: ReturnType<typeof createHavenMcpHttpHandler>,
  body: unknown,
  sessionId?: string,
): Promise<{ status: number; headers: Headers; json: unknown }> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await handler.fetch(
    new Request("http://127.0.0.1:8789/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    if (data) parsed = JSON.parse(data.slice(5).trim());
  }
  return { status: res.status, headers: res.headers, json: parsed };
};

/** Extract nested MCP JSON-RPC result from JSON or SSE body shapes. */
const extractToolText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") return String(payload);
  const root = payload as Record<string, unknown>;
  // Single JSON-RPC response
  if (root.result && typeof root.result === "object") {
    const result = root.result as Record<string, unknown>;
    const content = result.content;
    if (Array.isArray(content) && content[0] && typeof content[0] === "object") {
      const first = content[0] as { text?: string };
      if (typeof first.text === "string") return first.text;
    }
  }
  // Batch array
  if (Array.isArray(payload) && payload[0]) {
    return extractToolText(payload[0]);
  }
  return JSON.stringify(payload);
};

describe("createHavenMcpHttpHandler (Streamable HTTP)", () => {
  let handler: ReturnType<typeof createHavenMcpHttpHandler> | null = null;

  afterEach(async () => {
    if (handler) {
      await handler.close();
      handler = null;
    }
  });

  it("health and CORS preflight", async () => {
    handler = createHavenMcpHttpHandler({ baseUrl: "https://haven.test" });
    const health = await handler.fetch(new Request("http://127.0.0.1/health"));
    expect(health.status).toBe(200);
    const body = (await health.json()) as { transport: string };
    expect(body.transport).toBe("streamable-http");

    const preflight = await handler.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "OPTIONS",
        headers: { Origin: "https://example.com" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://example.com",
    );
  });

  it("initialize → tools/list → create_session scrubbing over HTTP", async () => {
    const { fetchImpl, calls } = mockGatewayFetch();
    handler = createHavenMcpHttpHandler({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });

    const init = await mcpPost(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "haven-mcp-test", version: "0.0.0" },
      },
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // Notifications often omit Accept; must not 406 (SDK requires both types).
    const inited = await handler.fetch(
      new Request("http://127.0.0.1:8789/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      }),
    );
    expect(inited.status).not.toBe(406);
    expect(inited.status).toBeLessThan(400);

    const listed = await mcpPost(
      handler,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId!,
    );
    expect(listed.status).toBe(200);
    const listBlob = JSON.stringify(listed.json);
    expect(listBlob).toContain("create_session");
    expect(listBlob).toContain("look_around");
    expect(listBlob.toLowerCase()).not.toContain("chatgpt");

    const created = await mcpPost(
      handler,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "create_session",
          arguments: { handle: "http-bot" },
        },
      },
      sessionId!,
    );
    expect(created.status).toBe(200);
    const toolText = extractToolText(created.json);
    const toolJson = JSON.parse(toolText) as Record<string, unknown>;
    expect(toolJson.sessionId).toBe("sess_http");
    expect(toolJson).not.toHaveProperty("sessionToken");
    expect(toolJson).not.toHaveProperty("signature");
    expect(toolResultLeaksSecrets(toolJson)).toBe(false);
    expect(toolText).not.toMatch(/\bhvs_/);

    const openCall = calls.find((c) => c.url.endsWith("/api/agent-session"));
    expect(openCall).toBeTruthy();

    const status = await mcpPost(
      handler,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "session_status", arguments: {} },
      },
      sessionId!,
    );
    const statusText = extractToolText(status.json);
    expect(toolResultLeaksSecrets(JSON.parse(statusText))).toBe(false);
    expect(statusText).not.toMatch(/\bhvs_/);
  });

  it.each([true, false])(
    "restores concurrent cold requests without client reinitialization or a new identity (JSON=%s)",
    async (enableJsonResponse) => {
      const { fetchImpl } = mockGatewayFetch();
      const kv = new Map<string, unknown>();
      let loads = 0;
      const durable = {
        load: async (id: string) => {
          loads++;
          await Promise.resolve();
          return (kv.get(id) as never) ?? null;
        },
        save: async (id: string, session: unknown) => {
          kv.set(id, session);
        },
        clear: async (id: string) => {
          kv.delete(id);
        },
      };
      handler = createHavenMcpHttpHandler({
        baseUrl: "https://haven.test",
        fetch: fetchImpl,
        enableJsonResponse,
        durable,
      });

      const init = await mcpPost(handler, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "durable-test", version: "0.0.0" },
        },
      });
      const sessionId = init.headers.get("mcp-session-id")!;
      await handler.fetch(
        new Request("http://127.0.0.1:8789/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "mcp-session-id": sessionId,
          },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        }),
      );
      await mcpPost(
        handler,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "create_session", arguments: { handle: "http-bot" } },
        },
        sessionId,
      );
      expect(kv.has(sessionId)).toBe(true);
      const stored = kv.get(sessionId) as { sessionToken: string };
      expect(stored.sessionToken).toMatch(/^hvs_/);

      // Simulate isolate wake: close in-memory MCP slots, keep durable KV.
      await handler.close();
      handler = createHavenMcpHttpHandler({
        baseUrl: "https://haven.test",
        fetch: fetchImpl,
        enableJsonResponse,
        durable,
      });

      const before = loads;
      const [status, listed] = await Promise.all([
        mcpPost(
          handler,
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "session_status", arguments: {} },
          },
          sessionId,
        ),
        mcpPost(
          handler,
          { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
          sessionId,
        ),
      ]);
      expect(status.status).toBe(200);
      expect(listed.status).toBe(200);
      expect(loads - before).toBe(1);
      expect(handler.sessionCount()).toBe(1);
      expect((kv.get(sessionId) as { protocolVersion: string }).protocolVersion).toBe(
        "2024-11-05",
      );
      const statusObj = JSON.parse(extractToolText(status.json)) as {
        open: boolean;
        handle?: string;
      };
      expect(statusObj.open).toBe(true);
      expect(statusObj.handle).toBe("http-bot");
      expect(toolResultLeaksSecrets(statusObj)).toBe(false);
    },
  );
});

it("refuses unknown and expired cold session ids without allocating slots", async () => {
  const cleared: string[] = [];
  const handler = createHavenMcpHttpHandler({
    durable: {
      load: async (id) =>
        id === "expired"
          ? {
              sessionId: "old",
              handle: "old",
              agentId: "old",
              actions: [],
              sessionToken: "hvs_expired_fixture",
              expiresAt: "2000-01-01T00:00:00Z",
            }
          : null,
      save: async () => {},
      clear: async (id) => {
        cleared.push(id);
      },
    },
  });
  for (const id of ["unknown", "expired"]) {
    const response = await mcpPost(
      handler,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      id,
    );
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.json)).not.toContain("hvs_");
  }
  expect(cleared).toEqual(["expired"]);
  expect(handler.sessionCount()).toBe(0);
  await handler.close();
});
