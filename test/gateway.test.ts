import { describe, expect, it } from "vitest";
import { HavenGatewayBridge, wakeWaitDelayMs } from "../src/gateway.js";
import type { ToolCallResult } from "../src/gateway.js";
import { GatewaySessionStore, toolResultLeaksSecrets } from "../src/session.js";
import { HAVEN_MCP_TOOL_GATEWAY, HAVEN_MCP_TOOLS } from "../src/tools.js";

type FetchCall = { url: string; init?: RequestInit };

const SESSION_TOKEN = "hvs_adapter_token_abcdefghijklmnop";
const LEAK_TOKEN = "hvs_should_be_scrubbed_from_action";
const LEAK_SIGNATURE = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Plant secrets Gateway must never echo into MCP tool results. */
const withLeaks = <T extends Record<string, unknown>>(
  body: T,
): T & {
  sessionToken: string;
  signature: string;
} => ({
  ...body,
  sessionToken: LEAK_TOKEN,
  signature: LEAK_SIGNATURE,
});

const mockFetch = (
  handler: (call: FetchCall) => Response,
): { fetchImpl: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
};

/** Assert every tool result is scrubbed (no hvs_…, no signature fields). */
const assertScrubbed = (result: ToolCallResult, label: string): void => {
  expect(result.ok, `${label} should succeed`).toBe(true);
  expect(toolResultLeaksSecrets(result.content), `${label} leaks secrets`).toBe(false);
  const blob = JSON.stringify(result.content);
  expect(blob, `${label} contains hvs_`).not.toMatch(/\bhvs_/);
  expect(blob, `${label} contains signature key`).not.toMatch(/"signature"\s*:/);
  expect(blob, `${label} contains sessionToken key`).not.toMatch(/"sessionToken"\s*:/i);
};

const parseBody = (call: FetchCall | undefined): Record<string, unknown> => {
  const raw = call?.init?.body;
  if (typeof raw !== "string") return {};
  return JSON.parse(raw) as Record<string, unknown>;
};

const authHeader = (call: FetchCall | undefined): string | undefined =>
  (call?.init?.headers as Record<string, string> | undefined)?.Authorization;

describe("HAVEN_MCP_TOOLS", () => {
  it("covers the operator flow without attestation tools", () => {
    const names = HAVEN_MCP_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "list_capabilities",
      "create_session",
      "session_status",
      "look_around",
      "find_agent",
      "request_collaboration",
      "delegate",
      "handoff",
      "work",
      "create_swarm",
      "join_swarm",
      "leave_swarm",
      "renew_swarm",
      "list_worlds",
      "join_world",
      "report_outcome",
      "wake",
      "wake_wait",
      "wake_cancel",
      "leave",
    ]);
    const blob = JSON.stringify(HAVEN_MCP_TOOLS).toLowerCase();
    expect(blob).not.toContain("attestation signature");
    expect(blob).not.toContain("haven agt_");
  });

  it("create_session documents Atlas location opt-in (shareLocation)", () => {
    const create = HAVEN_MCP_TOOLS.find((t) => t.name === "create_session");
    expect(create).toBeTruthy();
    const props = create!.inputSchema.properties;
    expect(props.shareLocation).toBeTruthy();
    const desc = JSON.stringify(props).toLowerCase();
    expect(desc).toContain("sharelocation");
    expect(desc).toMatch(/omit.*location|all required|opt-in/);
  });

  it("delegate tool requires skills, summary, and nextIntent", () => {
    const tool = HAVEN_MCP_TOOLS.find((t) => t.name === "delegate");
    expect(tool).toBeTruthy();
    expect(tool!.inputSchema.required).toEqual(
      expect.arrayContaining(["skills", "summary", "nextIntent"]),
    );
  });

  it("handoff tool exposes the read-only refine audit op with a capped pass", () => {
    const tool = HAVEN_MCP_TOOLS.find((t) => t.name === "handoff");
    expect(tool).toBeTruthy();
    const op = tool!.inputSchema.properties.op as { enum?: ReadonlyArray<string> };
    expect(op.enum).toContain("refine");
    const pass = tool!.inputSchema.properties.pass as {
      minimum?: number;
      maximum?: number;
    };
    expect(pass.maximum).toBe(2);
    expect(JSON.stringify(tool)).toContain("refine");
  });

  it("list_worlds is a read with no arguments and no session claim", () => {
    const tool = HAVEN_MCP_TOOLS.find((t) => t.name === "list_worlds");
    expect(tool).toBeTruthy();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.annotations?.destructiveHint).toBeUndefined();
    // No arguments at all: the read is the whole catalogue, and a filter here
    // would be a second shape that could disagree with `GET /api/worlds`.
    expect(Object.keys(tool!.inputSchema.properties)).toEqual([]);
    expect(tool!.inputSchema.required).toBeUndefined();
    expect(HAVEN_MCP_TOOL_GATEWAY.list_worlds).toEqual({
      method: "GET",
      path: "/api/worlds",
    });
    // The description has to carry what the payload needs, because a host reads
    // this and not the docs: that the list is not "mine", that `null` is not
    // `false`, and which tool to call next.
    const desc = tool!.description;
    expect(desc).toContain("do not own");
    expect(desc).toContain("requiresAttested");
    expect(desc).toContain("join_world");
  });

  it("join_world is annotated idempotent and takes only a world id and a role", () => {
    const tool = HAVEN_MCP_TOOLS.find((t) => t.name === "join_world");
    expect(tool).toBeTruthy();
    // Idempotent is the annotation a host reads before retrying a mutation, so it
    // has to be true of the route, not aspirational.
    expect(tool!.annotations?.idempotentHint).toBe(true);
    expect(tool!.annotations?.readOnlyHint).toBe(false);
    expect(tool!.inputSchema.required).toEqual(["worldId"]);
    const role = tool!.inputSchema.properties.role as { enum?: ReadonlyArray<string> };
    expect(role.enum).toEqual(["member", "observer"]);
    // Identity is the session, so no identity field may appear in the schema at
    // all. A `handle` property here would be an argument a prompt could fill in.
    const props = Object.keys(tool!.inputSchema.properties);
    expect(props).not.toContain("handle");
    expect(props).not.toContain("agentId");
    expect(HAVEN_MCP_TOOL_GATEWAY.join_world).toEqual({
      method: "POST",
      path: "/api/worlds/:id/join",
    });
  });

  it("report_outcome requires structured receipt fields and maps to the outcome route", () => {
    const tool = HAVEN_MCP_TOOLS.find((t) => t.name === "report_outcome");
    expect(tool).toBeTruthy();
    expect(tool!.inputSchema.required).toEqual(
      expect.arrayContaining(["deliveryRef", "verdict", "tried", "observed"]),
    );
    const verdict = tool!.inputSchema.properties.verdict as {
      enum?: ReadonlyArray<string>;
    };
    expect(verdict.enum).toEqual(expect.arrayContaining(["confirmed", "rejected"]));
    expect(tool!.annotations?.readOnlyHint).toBe(false);
  });
});

describe("HavenGatewayBridge", () => {
  it("list_worlds reads the ledger with no session and no Authorization header", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/worlds")) {
        return jsonResponse(200, [
          {
            id: "world_open",
            name: "Open room",
            status: "active",
            ownerHandle: "someone-else",
            participantCount: 2,
            resourceCount: 1,
            evidenceCount: 0,
            lookingCount: 0,
            handoffCount: 1,
            gardenCount: 0,
            ownerIdentity: "operator_attested",
            verdict: { code: "ALW", reason: "allowed by this deployment" },
            admission: {
              enterable: true,
              requiresAttested: null,
              reason: "live, 2 of 16 seats taken",
            },
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T01:00:00.000Z",
          },
        ]);
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });
    // No create_session first: discovery must work before authenticating, and
    // the test proves it by never opening one.
    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });
    const result = await bridge.call("list_worlds", {});
    assertScrubbed(result, "list_worlds");
    const rows = result.content as ReadonlyArray<{
      id: string;
      admission: { enterable: boolean };
    }>;
    expect(rows.map((r) => r.id)).toEqual(["world_open"]);
    expect(rows[0]!.admission.enterable).toBe(true);
    // A header promising caller-specific behaviour would be a claim the route
    // does not honour, since it composes nothing from the caller.
    expect(calls).toHaveLength(1);
    expect(authHeader(calls[0])).toBeUndefined();
    expect(calls[0]!.init?.method).toBe("GET");
  });

  it("list_worlds surfaces a refusal rather than an empty catalogue", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(503, {
        error: "DatabaseError",
        message: "Haven is temporarily unavailable. Try again in a moment.",
      }),
    );
    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });
    const result = await bridge.call("list_worlds", {});
    // An empty list here would read as "no Worlds exist", which is the one thing
    // a broken database must never be able to say.
    expect(result.ok).toBe(false);
    expect(result.content).toBeNull();
  });

  it("join_world posts the World route with session auth and no identity in the body", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_join",
          sessionToken: SESSION_TOKEN,
          handle: "mcp-joiner",
          agentId: "agt_joiner",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: ["join_world", "leave"],
          delivery: "header",
        });
      }
      if (call.url.endsWith("/api/worlds/world%20one/join")) {
        return jsonResponse(
          200,
          withLeaks({
            participant: {
              worldId: "world one",
              handle: "mcp-joiner",
              agentId: "agt_joiner",
              role: "observer",
              joinedAt: "2026-01-01T00:00:00.000Z",
            },
            snapshot: { id: "world one", activeParticipants: [{ handle: "mcp-joiner" }] },
            rejoin: false,
          }),
        );
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });
    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });
    await bridge.call("create_session", { handle: "mcp-joiner" });
    const result = await bridge.call("join_world", {
      worldId: "world one",
      role: "observer",
      handle: "someone-else",
      agentId: "agt_someone_else",
    });
    assertScrubbed(result, "join_world");
    expect((result.content as { rejoin: boolean }).rejoin).toBe(false);

    const joinCall = calls.find((c) => c.url.includes("/join"));
    expect(joinCall?.url).toBe("https://haven.test/api/worlds/world%20one/join");
    expect(joinCall?.init?.method).toBe("POST");
    // Haven-Session, never an attestation signature: the adapter holds the token.
    expect(authHeader(joinCall)).toBe(`Haven-Session ${SESSION_TOKEN}`);
    // The hostile arguments are dropped rather than forwarded, which is the whole
    // reason identity never appears in the tool schema.
    expect(parseBody(joinCall)).toEqual({ role: "observer" });
  });

  it("join_world without a worldId fails before any request", async () => {
    // The session opens normally, so the only thing that can refuse the call is
    // the missing argument. A mock that failed every request would prove nothing
    // about which check fired first.
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_join",
          sessionToken: SESSION_TOKEN,
          handle: "mcp-joiner",
          agentId: "agt_joiner",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: ["join_world", "leave"],
          delivery: "header",
        });
      }
      return jsonResponse(500, {
        error: "DatabaseError",
        message: "should not be called",
      });
    });
    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });
    await bridge.call("create_session", { handle: "mcp-joiner" });
    const result = await bridge.call("join_world", {});
    expect(result.ok).toBe(false);
    expect(String((result as { error?: string }).error)).toContain("worldId");
    expect(calls.some((c) => c.url.includes("/join"))).toBe(false);
  });

  it("delegate posts Looking+offer via gateway path and scrubs secrets", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_delegate",
          sessionToken: SESSION_TOKEN,
          handle: "mcp-delegate",
          agentId: "agt_delegate",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: ["delegate", "work", "handoff", "leave"],
          delivery: "header",
          signature: "should_never_reach_tools",
        });
      }
      if (call.url.endsWith("/api/agent-session/delegate")) {
        return jsonResponse(
          200,
          withLeaks({
            action: "delegate",
            friction: "collapsed",
            intent: { id: "look_d1", handle: "mcp-delegate", skills: ["coding"] },
            packet: {
              id: "hnd_d1",
              lookingId: "look_d1",
              summary: "Review the yield summary",
              nextIntent: "Return a short note",
              status: "open",
            },
            next: { tools: ["work", "handoff", "wake", "leave"] },
          }),
        );
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });
    await bridge.call("create_session", { handle: "mcp-delegate" });
    const result = await bridge.call("delegate", {
      skills: ["coding"],
      summary: "Review the yield summary with enough length",
      nextIntent: "Return a short note",
    });
    expect(result.ok).toBe(false);
    expect(toolResultLeaksSecrets(result.content)).toBe(false);
    expect(result.content).toMatchObject({ offerRecorded: true });
    expect((result.content as { action: string }).action).toBe("delegate");
    expect((result.content as { friction: string }).friction).toBe("collapsed");
    expect((result.content as { packet: { lookingId: string } }).packet.lookingId).toBe(
      "look_d1",
    );

    const delegateCall = calls.find((c) => c.url.endsWith("/api/agent-session/delegate"));
    expect(delegateCall).toBeTruthy();
    expect(authHeader(delegateCall)).toMatch(/^Haven-Session /);
    expect(parseBody(delegateCall).skills).toEqual(["coding"]);
  });

  it("create_session stores token server-side and never returns it", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_mcp",
          sessionToken: SESSION_TOKEN,
          handle: "mcp-bot",
          agentId: "agt_mcp",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: ["look_around", "find_agent", "leave"],
          delivery: "header",
          signature: "should_never_reach_tools",
          auth: {
            header: `Authorization: Haven-Session ${SESSION_TOKEN}`,
            note: "once",
          },
        });
      }
      if (call.url.endsWith("/api/agent-session/look-around")) {
        return jsonResponse(200, [
          {
            id: "pre_1",
            handle: "peer",
            city: "Lisbon",
            activity: "coding",
            attested: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T00:05:00.000Z",
          },
        ]);
      }
      if (call.url.endsWith("/api/agent-session/find-agent")) {
        return jsonResponse(
          200,
          withLeaks({
            action: "find_agent",
            surface: "looking",
            posted: true,
            candidates: [{ handle: "peer", score: 1 }],
          }),
        );
      }
      if (call.url.endsWith("/api/agent-session/leave")) {
        return jsonResponse(200, { ok: true, handle: "mcp-bot" });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });

    const opened = await bridge.call("create_session", { handle: "mcp-bot" });
    assertScrubbed(opened, "create_session");
    const body = opened.content as Record<string, unknown>;
    expect(body.sessionId).toBe("sess_mcp");
    expect(body.handle).toBe("mcp-bot");
    expect(body).not.toHaveProperty("sessionToken");
    expect(body).not.toHaveProperty("signature");

    const status = await bridge.call("session_status", {});
    assertScrubbed(status, "session_status");
    expect((status.content as { open: boolean }).open).toBe(true);

    const look = await bridge.call("look_around", { attestedOnly: true });
    assertScrubbed(look, "look_around");
    const lookCall = calls.find((c) => c.url.endsWith("/api/agent-session/look-around"));
    expect(authHeader(lookCall)).toBe(`Haven-Session ${SESSION_TOKEN}`);
    expect(authHeader(lookCall)).not.toMatch(/^Haven agt_/);

    const found = await bridge.call("find_agent", {
      title: "Need a coding peer",
      body: "Looking for attested help on a bounded plot",
      skills: ["coding"],
    });
    assertScrubbed(found, "find_agent");

    const left = await bridge.call("leave", {});
    assertScrubbed(left, "leave");
    expect(bridge.store.hasSession()).toBe(false);
  });

  it("create_session forwards shareLocation with full Atlas fields", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_atlas",
          sessionToken: SESSION_TOKEN,
          handle: "atlas-bot",
          agentId: "agt_atlas",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: ["look_around", "leave"],
          delivery: "header",
        });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });

    const opened = await bridge.call("create_session", {
      handle: "atlas-bot",
      shareLocation: true,
      city: "Lisbon",
      region: "Lisbon",
      country: "PT",
      lat: 38.7,
      lon: -9.1,
      activity: "research",
    });
    assertScrubbed(opened, "create_session");

    const openCall = calls.find((c) => c.url.endsWith("/api/agent-session"));
    expect(parseBody(openCall)).toMatchObject({
      handle: "atlas-bot",
      delivery: "header",
      shareLocation: true,
      city: "Lisbon",
      region: "Lisbon",
      country: "PT",
      lat: 38.7,
      lon: -9.1,
      activity: "research",
    });
  });

  it("create_session omits location when only handle/activity are set", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_noloc",
          sessionToken: SESSION_TOKEN,
          handle: "noloc-bot",
          agentId: "agt_noloc",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: ["look_around", "leave"],
          delivery: "header",
        });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });

    await bridge.call("create_session", {
      handle: "noloc-bot",
      activity: "research",
    });

    const openCall = calls.find((c) => c.url.endsWith("/api/agent-session"));
    const body = parseBody(openCall);
    expect(body).toMatchObject({
      handle: "noloc-bot",
      delivery: "header",
      activity: "research",
    });
    expect(body).not.toHaveProperty("shareLocation");
    expect(body).not.toHaveProperty("city");
    expect(body).not.toHaveProperty("lat");
  });

  it("claimable-work loop: find peer → handoff → garden work → leave, scrubbed", async () => {
    let gardenSessionId = "gs_pending";
    let handoffId = "ho_pending";
    let handoffStatus: "open" | "claimed" | "completed" = "open";

    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_wedge",
          sessionToken: SESSION_TOKEN,
          handle: "wedge-bot",
          agentId: "agt_wedge",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: [
            "look_around",
            "find_agent",
            "request_collaboration",
            "handoff",
            "work",
            "leave",
          ],
          delivery: "header",
          signature: LEAK_SIGNATURE,
          auth: {
            header: `Authorization: Haven-Session ${SESSION_TOKEN}`,
            note: "adapter-only",
          },
        });
      }

      if (call.url.endsWith("/api/agent-session/look-around")) {
        return jsonResponse(200, [
          {
            id: "pre_peer",
            handle: "peer-coder",
            city: "Lisbon",
            activity: "coding",
            attested: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T00:05:00.000Z",
            note: `do not paste ${LEAK_TOKEN}`,
          },
        ]);
      }

      if (call.url.endsWith("/api/agent-session/find-agent")) {
        return jsonResponse(
          200,
          withLeaks({
            action: "find_agent",
            surface: "looking",
            posted: true,
            intentId: "li_find_1",
            candidates: [{ handle: "peer-coder", score: 0.92, attested: true }],
          }),
        );
      }

      if (call.url.endsWith("/api/agent-session/request-collaboration")) {
        return jsonResponse(
          200,
          withLeaks({
            action: "request_collaboration",
            surface: "looking",
            posted: true,
            intentId: "li_collab_1",
            next: {
              method: "POST",
              path: "/api/agent-session/find-agent",
              why: "Match this Looking intent against the Atlas roster",
            },
          }),
        );
      }

      if (call.url.endsWith("/api/agent-session/work")) {
        const body = parseBody(call);
        const op = body.op;
        if (op === "start") {
          gardenSessionId = "gs_wedge_1";
          return jsonResponse(
            200,
            withLeaks({
              action: "work",
              op: "start",
              session: {
                id: gardenSessionId,
                handle: "wedge-bot",
                agentId: "agt_wedge",
                status: "running",
                steps: 0,
                maxSteps: 10,
              },
              bounds: { maxStepsCap: 20, maxTicksPerCall: 5, singlePlot: true },
            }),
          );
        }
        if (op === "tick") {
          return jsonResponse(
            200,
            withLeaks({
              action: "work",
              op: "tick",
              session: {
                id: body.sessionId ?? gardenSessionId,
                handle: "wedge-bot",
                status: "running",
                steps: 2,
                maxSteps: 10,
              },
              ticksApplied: 2,
              bounds: { maxStepsCap: 20, maxTicksPerCall: 5, singlePlot: true },
            }),
          );
        }
        if (op === "yield") {
          return jsonResponse(
            200,
            withLeaks({
              action: "work",
              op: "yield",
              session: {
                id: body.sessionId ?? gardenSessionId,
                handle: "wedge-bot",
                status: "yielded",
                steps: 2,
                maxSteps: 10,
                summary: body.summary,
              },
              bounds: { maxStepsCap: 20, maxTicksPerCall: 5, singlePlot: true },
            }),
          );
        }
        return jsonResponse(400, {
          error: "Validation",
          message: `unknown work op ${String(op)}`,
        });
      }

      if (call.url.endsWith("/api/agent-session/handoff")) {
        const body = parseBody(call);
        const op = body.op;
        if (op === "list") {
          return jsonResponse(
            200,
            withLeaks({
              action: "handoff",
              op: "list",
              packets: [
                {
                  id: "ho_open_1",
                  fromHandle: "peer-coder",
                  fromAgentId: "agt_peer",
                  summary: "Open claimable packet for chainable loop",
                  nextIntent: "Continue coding from yield",
                  requiredSkills: ["coding"],
                  status: "open",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  expiresAt: "2026-01-01T06:00:00.000Z",
                },
              ],
              count: 1,
              next: {
                tools: ["handoff", "work"],
                ops: ["claim", "claim_next", "offer"],
                why: "Claim a packet by id, or claim_next for the newest matching open packet",
              },
            }),
          );
        }
        if (op === "claim_next") {
          handoffId = "ho_wedge_1";
          handoffStatus = "claimed";
          return jsonResponse(
            200,
            withLeaks({
              action: "handoff",
              op: "claim_next",
              packet: {
                id: handoffId,
                fromHandle: "peer-coder",
                claimedByHandle: "wedge-bot",
                status: handoffStatus,
                claimedAt: "2026-01-01T00:10:00.000Z",
                requiredSkills: ["coding"],
              },
              next: {
                tools: ["work", "handoff"],
                ops: ["start", "tick", "yield", "complete"],
                why: "Start bounded Garden work on the claimed packet, then complete the handoff",
              },
            }),
          );
        }
        if (op === "offer") {
          handoffId = "ho_wedge_2";
          handoffStatus = "open";
          return jsonResponse(
            200,
            withLeaks({
              action: "handoff",
              op: "offer",
              packet: {
                id: handoffId,
                fromHandle: "wedge-bot",
                fromAgentId: "agt_wedge",
                gardenSessionId: body.gardenSessionId ?? gardenSessionId,
                summary: body.summary,
                nextIntent: body.nextIntent,
                requiredSkills: body.requiredSkills ?? ["coding"],
                status: handoffStatus,
                createdAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2026-01-01T06:00:00.000Z",
              },
            }),
          );
        }
        if (op === "claim") {
          handoffStatus = "claimed";
          return jsonResponse(
            200,
            withLeaks({
              action: "handoff",
              op: "claim",
              packet: {
                id: body.handoffId ?? handoffId,
                fromHandle: "wedge-bot",
                claimedByHandle: "peer-coder",
                status: handoffStatus,
                claimedAt: "2026-01-01T00:10:00.000Z",
              },
            }),
          );
        }
        if (op === "complete") {
          handoffStatus = "completed";
          return jsonResponse(
            200,
            withLeaks({
              action: "handoff",
              op: "complete",
              packet: {
                id: body.handoffId ?? handoffId,
                status: handoffStatus,
                claimedByHandle: "wedge-bot",
              },
              next: {
                tools: ["handoff", "work", "leave"],
                ops: ["list", "claim_next"],
                why: "Claim the next open packet to continue the chainable claimable-work loop",
              },
            }),
          );
        }
        return jsonResponse(400, {
          error: "Validation",
          message: `unknown handoff op ${String(op)}`,
        });
      }

      if (call.url.endsWith("/api/agent-session/leave")) {
        return jsonResponse(200, withLeaks({ ok: true, handle: "wedge-bot" }));
      }

      if (call.url.endsWith("/api/agent-session/outcome")) {
        const body = parseBody(call);
        return jsonResponse(
          200,
          withLeaks({
            action: "outcome",
            receipt: {
              id: "ev_out_1",
              handle: "peer-coder",
              category: "outcome_confirmed",
              outcome: "success",
              referenceId: body.deliveryRef,
              verifiedBy: "wedge-bot",
              provenance: "attributable",
            },
            next: {
              tools: ["handoff", "wake", "leave"],
              why: "Receipt recorded.",
            },
          }),
        );
      }

      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });

    // 1. Open session (token stays in adapter)
    const opened = await bridge.call("create_session", {
      handle: "wedge-bot",
      city: "Lisbon",
      activity: "coding",
    });
    assertScrubbed(opened, "create_session");
    expect((opened.content as { sessionId: string }).sessionId).toBe("sess_wedge");

    // 2. Find peer (look + Looking)
    const look = await bridge.call("look_around", { attestedOnly: true });
    assertScrubbed(look, "look_around");
    expect(Array.isArray(look.content)).toBe(true);

    const found = await bridge.call("find_agent", {
      title: "Need a coding peer for a bounded plot",
      body: "Claimable handoff after Garden yield",
      skills: ["coding", "garden"],
    });
    assertScrubbed(found, "find_agent");
    expect((found.content as { candidates: unknown[] }).candidates).toHaveLength(1);

    const collab = await bridge.call("request_collaboration", {
      title: "Bounded plot collaborator",
      body: "Prefer attested peer with coding + garden skills",
      skills: ["coding", "garden"],
      urgency: "normal",
    });
    assertScrubbed(collab, "request_collaboration");
    expect((collab.content as { intentId: string }).intentId).toBe("li_collab_1");

    // 3. Garden work: start → tick → yield
    const started = await bridge.call("work", { op: "start", maxSteps: 10 });
    assertScrubbed(started, "work start");
    const startedBody = started.content as {
      session: { id: string; status: string };
    };
    expect(startedBody.session.id).toBe("gs_wedge_1");
    expect(startedBody.session.status).toBe("running");

    const ticked = await bridge.call("work", {
      op: "tick",
      sessionId: startedBody.session.id,
      ticks: 2,
    });
    assertScrubbed(ticked, "work tick");
    expect((ticked.content as { ticksApplied: number }).ticksApplied).toBe(2);

    const yielded = await bridge.call("work", {
      op: "yield",
      sessionId: startedBody.session.id,
      summary: "Plot checkpoint ready for peer claim",
    });
    assertScrubbed(yielded, "work yield");
    expect((yielded.content as { session: { status: string } }).session.status).toBe(
      "yielded",
    );

    // 4. Handoff: list → claim_next → complete (chainable), then leave
    const listed = await bridge.call("handoff", {
      op: "list",
      requiredSkills: ["coding"],
    });
    assertScrubbed(listed, "handoff list");
    expect((listed.content as { op: string; count: number }).op).toBe("list");
    expect((listed.content as { count: number }).count).toBeGreaterThanOrEqual(1);

    const claimedNext = await bridge.call("handoff", {
      op: "claim_next",
      requiredSkills: ["coding"],
    });
    assertScrubbed(claimedNext, "handoff claim_next");
    const claimedPacket = (
      claimedNext.content as { packet: { id: string; status: string } | null }
    ).packet;
    expect(claimedPacket?.status).toBe("claimed");

    const completed = await bridge.call("handoff", {
      op: "complete",
      handoffId: claimedPacket!.id,
    });
    assertScrubbed(completed, "handoff complete");
    expect((completed.content as { packet: { status: string } }).packet.status).toBe(
      "completed",
    );
    expect(
      ((completed.content as { next?: { ops?: string[] } }).next?.ops ?? []).includes(
        "claim_next",
      ),
    ).toBe(true);

    // Also cover explicit offer → claim for parity
    const offered = await bridge.call("handoff", {
      op: "offer",
      gardenSessionId: startedBody.session.id,
      summary: "Plot checkpoint ready for peer claim",
      nextIntent: "Continue coding ticks from yield",
      requiredSkills: ["coding"],
    });
    expect(offered.ok).toBe(false);
    expect(toolResultLeaksSecrets(offered.content)).toBe(false);
    expect(offered.content).toMatchObject({ offerRecorded: true });
    const offeredPacket = (offered.content as { packet: { id: string; status: string } })
      .packet;
    expect(offeredPacket.status).toBe("open");

    const claimed = await bridge.call("handoff", {
      op: "claim",
      handoffId: offeredPacket.id,
    });
    assertScrubbed(claimed, "handoff claim");
    expect((claimed.content as { packet: { status: string } }).packet.status).toBe(
      "claimed",
    );

    // 5. Outcome receipt over the session identity, then leave
    const reported = await bridge.call("report_outcome", {
      deliveryRef: "ev_del_1",
      verdict: "confirmed",
      tried: "Ran the delivery against fixtures",
      observed: "All green",
    });
    assertScrubbed(reported, "report_outcome");
    expect((reported.content as { action: string }).action).toBe("outcome");
    expect(
      (reported.content as { receipt: { verifiedBy: string } }).receipt.verifiedBy,
    ).toBe("wedge-bot");

    // 6. Leave and clear adapter store
    const left = await bridge.call("leave", {});
    assertScrubbed(left, "leave");
    expect(bridge.store.hasSession()).toBe(false);

    // Session auth used on every Gateway verb (never attestation form)
    const authedPaths = [
      "/api/agent-session/look-around",
      "/api/agent-session/find-agent",
      "/api/agent-session/request-collaboration",
      "/api/agent-session/work",
      "/api/agent-session/handoff",
      "/api/agent-session/outcome",
      "/api/agent-session/leave",
    ];
    for (const path of authedPaths) {
      const matched = calls.filter((c) => c.url.endsWith(path));
      expect(matched.length, `calls to ${path}`).toBeGreaterThan(0);
      for (const c of matched) {
        expect(authHeader(c)).toBe(`Haven-Session ${SESSION_TOKEN}`);
        expect(authHeader(c)).not.toMatch(/^Haven agt_/);
      }
    }

    // Work and handoff request bodies carry the expected ops
    const workBodies = calls
      .filter((c) => c.url.endsWith("/api/agent-session/work"))
      .map(parseBody);
    expect(workBodies.map((b) => b.op)).toEqual(["start", "tick", "yield"]);

    const handoffBodies = calls
      .filter((c) => c.url.endsWith("/api/agent-session/handoff"))
      .map(parseBody);
    expect(handoffBodies.map((b) => b.op)).toEqual([
      "list",
      "claim_next",
      "complete",
      "offer",
      "wait",
      "claim",
    ]);
  });

  it("fails closed when tools are called without a session", async () => {
    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: async () => jsonResponse(500, { error: "should not call" }),
    });
    const look = await bridge.call("look_around", {});
    expect(look.ok).toBe(false);
    expect(look.error).toMatch(/create_session/i);
  });

  it("wake arms, waits, and cancels without leaking session material", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_wake",
          sessionToken: SESSION_TOKEN,
          handle: "wake-bot",
          agentId: "agt_wake",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: ["wake", "leave"],
          delivery: "header",
        });
      }
      if (call.url.endsWith("/api/agent-session/wake")) {
        const body = parseBody(call);
        if (body.op === "watch") {
          return jsonResponse(
            200,
            withLeaks({
              action: "wake",
              op: "watch",
              subscription: {
                id: "wake_7f31",
                handle: "wake-bot",
                status: "armed",
                skills: ["rust", "llvm"],
              },
              newEvents: [],
              pending: [],
            }),
          );
        }
        if (body.op === "poll") {
          // Adapter poll loop: first pass quiet, second pass delivers.
          const polls = calls.filter(
            (c) =>
              c.url.endsWith("/api/agent-session/wake") &&
              (parseBody(c).op as string) === "poll",
          ).length;
          const pending =
            polls < 2
              ? []
              : [
                  {
                    id: "evt_1",
                    type: "handoff_offered",
                    resourceType: "handoff",
                    resourceId: "hnd_92af",
                    why: ["skill: rust", "skill: llvm"],
                    next: { method: "POST", path: "/api/handoff/claim" },
                    from: "compiler-fox",
                  },
                ];
          return jsonResponse(
            200,
            withLeaks({
              action: "wake",
              op: "poll",
              subscription: { id: "wake_7f31", status: "triggered" },
              newEvents: [],
              pending,
            }),
          );
        }
        if (body.op === "ack") {
          return jsonResponse(200, {
            action: "wake",
            op: "ack",
            subscription: { id: "wake_7f31", status: "consumed" },
            newEvents: [],
            pending: [],
          });
        }
        if (body.op === "cancel") {
          return jsonResponse(200, {
            action: "wake",
            op: "cancel",
            subscription: { id: "wake_7f31", status: "cancelled" },
            newEvents: [],
            pending: [],
          });
        }
      }
      return jsonResponse(404, { error: "NotFound", message: "no route" });
    });
    const bridge = new HavenGatewayBridge({
      baseUrl: "https://haven.test",
      fetch: fetchImpl,
    });
    await bridge.call("create_session", { handle: "wake-bot" });

    const missing = await bridge.call("wake", {});
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/skills/i);

    const armed = await bridge.call("wake", {
      handoffId: "hnd_92af",
      skills: ["rust", "llvm"],
      surfaces: ["handoff"],
      events: ["offered"],
      reason: "WAIT_FOR_HANDOFF",
      ttlMs: 3600000,
      maxEvents: 1,
    });
    assertScrubbed(armed, "wake");
    expect((armed.content as { subscription: { id: string } }).subscription.id).toBe(
      "wake_7f31",
    );

    const woken = await bridge.call("wake_wait", {
      wakeId: "wake_7f31",
      timeoutSeconds: 5,
    });
    assertScrubbed(woken, "wake_wait");
    expect(woken.content).toMatchObject({
      wakeId: "wake_7f31",
      triggered: true,
      event: { type: "handoff_offered", resource: "hnd_92af" },
    });

    const cancelled = await bridge.call("wake_cancel", { wakeId: "wake_7f31" });
    assertScrubbed(cancelled, "wake_cancel");

    const wakeBodies = calls
      .filter((c) => c.url.endsWith("/api/agent-session/wake"))
      .map(parseBody);
    // Adapter poll loop: watch, quiet poll, delivering poll, ack-take, cancel.
    expect(wakeBodies.map((b) => b.op)).toEqual([
      "watch",
      "poll",
      "poll",
      "ack",
      "cancel",
    ]);
    expect(wakeBodies.find((b) => b.op === "watch")?.handoffId).toBe("hnd_92af");
    const ackBody = wakeBodies.find((b) => b.op === "ack");
    expect(ackBody?.eventIds).toEqual(["evt_1"]);
    for (const c of calls.filter((cc) => cc.url.endsWith("/api/agent-session/wake"))) {
      expect(authHeader(c)).toBe(`Haven-Session ${SESSION_TOKEN}`);
    }
  });
});

describe("wakeWaitDelayMs", () => {
  it("backs off 1s, 2s, then 5s (mirrors wakeWaitPollDelayMs)", () => {
    expect([0, 1, 2, 3, 10].map(wakeWaitDelayMs)).toEqual([1000, 2000, 5000, 5000, 5000]);
  });
});

it("retains an opted-in continuation across leave and durable hydration without exposing it", async () => {
  const continuation = "hvr_" + "a".repeat(32);
  let saved: import("../src/session.js").StoredGatewaySession | null = null;
  let opens = 0;
  const { fetchImpl, calls } = mockFetch(({ url, init }) => {
    if (url.endsWith("/api/agent-session")) {
      opens++;
      const body = JSON.parse(String(init?.body));
      if (opens === 1) expect(body.resumable).toBe(true);
      else {
        expect(body.resume).toBe(true);
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          `Haven-Resume ${continuation}`,
        );
      }
      return jsonResponse(200, {
        sessionId: "ags_resume",
        handle: "resume-mcp",
        agentId: "agt_original",
        expiresAt: "2099-01-01T00:00:00.000Z",
        actions: ["handoff", "leave"],
        sessionToken: opens === 1 ? SESSION_TOKEN : "hvs_rotated_access_abcdefghijklmnop",
        resumeToken: opens === 1 ? continuation : "hvr_" + "b".repeat(32),
      });
    }
    if (url.endsWith("/api/agent-session/leave"))
      return jsonResponse(200, { ok: true, handle: "resume-mcp" });
    return jsonResponse(404, { error: "NotFound" });
  });
  const store = new GatewaySessionStore({
    onSet: async (value) => {
      await Promise.resolve();
      saved = value;
    },
  });
  const first = new HavenGatewayBridge({ fetch: fetchImpl, store });
  assertScrubbed(
    await first.call("create_session", { handle: "resume-mcp", resumable: true }),
    "create",
  );
  assertScrubbed(await first.call("leave", {}), "leave");
  expect(store.hasSession()).toBe(false);
  expect(store.getToken()).toBeNull();
  expect(store.getResumeToken("resume-mcp")).toBe(continuation);
  expect(store.getPublic()).not.toHaveProperty("resumeToken");
  // A fresh adapter instance has only the persisted continuation, not a live access token.
  const hydrated = new GatewaySessionStore();
  hydrated.hydrate(saved);
  const second = new HavenGatewayBridge({ fetch: fetchImpl, store: hydrated });
  expect((await second.call("session_status", {})).content).toMatchObject({
    open: false,
    resumable: true,
  });
  assertScrubbed(
    await second.call("create_session", { handle: "resume-mcp", resume: true }),
    "resume",
  );
  expect(hydrated.getToken()).toBe("hvs_rotated_access_abcdefghijklmnop");
  expect(hydrated.getResumeToken("resume-mcp")).toBe("hvr_" + "b".repeat(32));
  expect(calls).toHaveLength(3);
});

it.each([409, 503])(
  "keeps access when leave returns %s and forwards explicit force",
  async (status) => {
    const continuation = "hvr_" + "a".repeat(32);
    const store = new GatewaySessionStore();
    store.set({
      sessionId: "ags_waiting",
      handle: "waiting-mcp",
      agentId: "agt_waiting",
      expiresAt: "2099-01-01T00:00:00.000Z",
      actions: ["handoff", "leave"],
      sessionToken: SESSION_TOKEN,
      resumeToken: continuation,
    });
    const { fetchImpl } = mockFetch(({ url, init }) => {
      expect(url).toContain("/api/agent-session/leave");
      const body = JSON.parse(String(init?.body));
      if (!body.force)
        return jsonResponse(status, {
          error: status === 409 ? "WorkPending" : "DatabaseError",
          message: "Session retained for pending work. Use force: true to leave now.",
        });
      return jsonResponse(200, { ok: true, handle: "waiting-mcp" });
    });
    const bridge = new HavenGatewayBridge({ fetch: fetchImpl, store });
    const refused = await bridge.call("leave", {});
    expect(refused.ok).toBe(false);
    expect(store.getToken()).toBe(SESSION_TOKEN);
    expect(store.getResumeToken("waiting-mcp")).toBe(continuation);
    expect((await bridge.call("session_status", {})).content).toMatchObject({
      open: true,
    });
    assertScrubbed(await bridge.call("leave", { force: true }), "forced leave");
    expect(store.getToken()).toBeNull();
  },
);

it("declares and forwards explicit arrival attribution rather than silently dropping it", async () => {
  const tool = HAVEN_MCP_TOOLS.find((t) => t.name === "create_session")!;
  expect(
    (tool.inputSchema.properties.arrivalSource as { enum: string[] }).enum,
  ).toContain("explicit_human_instruction");
  let body: Record<string, unknown> = {};
  const bridge = new HavenGatewayBridge({
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(200, {
        sessionId: "arrival",
        handle: "arrival",
        agentId: "agt_arrival",
        sessionToken: SESSION_TOKEN,
        expiresAt: "2099-01-01T00:00:00Z",
        actions: [],
      });
    }) as typeof fetch,
  });
  expect(
    (
      await bridge.call("create_session", {
        handle: "arrival",
        arrivalSource: "explicit_human_instruction",
        arrivalReferrer: "requester",
      })
    ).ok,
  ).toBe(true);
  expect(body.arrivalSource).toBe("explicit_human_instruction");
  expect(body.arrivalReferrer).toBe("requester");
});

it("preserves HTTP refusal classification without exposing response secrets", async () => {
  const store = new GatewaySessionStore();
  store.set({
    sessionId: "error",
    handle: "error",
    agentId: "agt_error",
    actions: [],
    expiresAt: "2099-01-01T00:00:00Z",
    sessionToken: SESSION_TOKEN,
  });
  const bridge = new HavenGatewayBridge({
    store,
    fetch: (async () =>
      jsonResponse(400, {
        error: "SecretDetected",
        message: "Content refusal for evidenceNote, not a length error.",
        sessionToken: LEAK_TOKEN,
      })) as typeof fetch,
  });
  const result = await bridge.call("handoff", {
    op: "complete",
    handoffId: "hnd_error",
    evidenceNote: "A detailed review",
  });
  expect(result.errorDetails).toEqual({ status: 400, code: "SecretDetected" });
  expect(toolResultLeaksSecrets(result)).toBe(false);
});

it.each(["awaiting_verdict", "rework_required", "accepted"])(
  "owns the post-delivery wait and exposes %s accurately",
  async (state) => {
    const calls: string[] = [];
    const store = new GatewaySessionStore();
    store.set({
      sessionId: "lifecycle",
      agentId: "agt_lifecycle",
      handle: "lifecycle",
      expiresAt: "2099-01-01T00:00:00Z",
      sessionToken: SESSION_TOKEN,
      actions: [],
    });
    const bridge = new HavenGatewayBridge({
      store,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body.op);
        if (body.op === "complete")
          return jsonResponse(200, {
            delivered: true,
            packet: { id: "hnd_lifecycle", status: "delivered" },
          });
        return jsonResponse(200, {
          handoffId: "hnd_lifecycle",
          followUp: {
            state,
            workComplete: state === "accepted",
            requiresContinuation: state === "awaiting_verdict",
            requiresAction: state === "rework_required",
          },
          nextToolCall: {
            name: "handoff",
            arguments: {
              op: state === "rework_required" ? "complete" : "wait",
              handoffId: "hnd_lifecycle",
            },
          },
          ...(state === "rework_required"
            ? { feedback: { summary: "Add the observed headers", id: "ev_verdict" } }
            : {}),
        });
      }) as typeof fetch,
    });
    const result = await bridge.call("handoff", {
      op: "complete",
      handoffId: "hnd_lifecycle",
      evidenceNote: "A checked delivery",
      timeoutSeconds: 0,
    });
    expect(calls).toEqual(["complete", "wait"]);
    expect(result.ok).toBe(state === "accepted");
    expect((result.content as { deliveryRecorded: boolean }).deliveryRecorded).toBe(true);
    if (state === "awaiting_verdict")
      expect(result.errorDetails?.code).toBe("WorkPending");
    if (state === "rework_required")
      expect(result.errorDetails?.code).toBe("ReworkRequired");
    expect(store.getToken()).toBe(SESSION_TOKEN);
  },
);

it("retains the delivery receipt when observation fails after submission", async () => {
  const store = new GatewaySessionStore();
  store.set({
    sessionId: "lifecycle",
    agentId: "agt_lifecycle",
    handle: "lifecycle",
    expiresAt: "2099-01-01T00:00:00Z",
    sessionToken: SESSION_TOKEN,
    actions: [],
  });
  const bridge = new HavenGatewayBridge({
    store,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return body.op === "complete"
        ? jsonResponse(200, {
            delivered: true,
            packet: { id: "hnd_lifecycle", status: "delivered" },
          })
        : jsonResponse(503, { error: "DatabaseError", message: "Store unavailable" });
    }) as typeof fetch,
  });
  const result = await bridge.call("handoff", {
    op: "complete",
    handoffId: "hnd_lifecycle",
    evidenceNote: "A checked delivery",
    timeoutSeconds: 0,
  });
  expect(result.ok).toBe(false);
  expect(result.content).toMatchObject({
    deliveryRecorded: true,
    waitError: { status: 503 },
    nextToolCall: { arguments: { op: "wait" } },
  });
});
