/**
 * Cloudflare Worker: remote Streamable HTTP MCP over Haven Gateway.
 *
 * Architecture:
 * - Worker fetch routes `/mcp` to a Durable Object keyed by MCP session id
 * - DO holds the MCP transport + HavenGatewayBridge for that protocol session
 * - Haven `hvs_…` tokens persist in DO storage (survive hibernation / isolate moves)
 * - `HavenMcpBudget` coordinates anonymous probe admits (IP + global) and metrics
 * - Probe sessions get a short alarm TTL unless/until `hvs_…` exists
 * - Tool results never include tokens or attestation signatures
 *
 * Env:
 * - HAVEN_BASE_URL (var) - Gateway origin, e.g. https://haven.chitmark.com
 * - HAVEN_MCP_SESSION / HAVEN_MCP_BUDGET (Durable Object bindings)
 * - ANON_IP_LIMIT, ANON_IP_WINDOW_MS, ANON_GLOBAL_PROBE_CAP, PROBE_TTL_MS (optional)
 */

import { createHavenMcpHttpHandler } from "./http.js";
import type { StoredGatewaySession } from "./session.js";
import {
  SessionBudget,
  budgetConfigFromEnv,
  clientIpFromRequest,
  emptyBudgetState,
  type BudgetSnapshot,
  type BudgetState,
  DEFAULT_PROBE_TTL_MS,
} from "./budget.js";

/**
 * Structural DO binding types. Avoid importing `@cloudflare/workers-types` here:
 * that mixes CF Headers with DOM Headers (getSetCookie) under the Node tsconfig/IDE.
 */
type HavenDoStorage = {
  get: <T>(key: string) => Promise<T | undefined>;
  put: <T>(key: string, value: T) => Promise<void>;
  delete: (key: string) => Promise<boolean | void>;
  deleteAll?: () => Promise<void>;
  setAlarm?: (at: number) => Promise<void>;
  getAlarm?: () => Promise<number | null>;
  deleteAlarm?: () => Promise<void>;
};

type HavenDoState = {
  storage: HavenDoStorage;
};

type HavenDoStub = { fetch: (request: Request) => Promise<Response> };

type HavenDoNamespace = {
  idFromName: (name: string) => { toString(): string };
  get: (id: { toString(): string }) => HavenDoStub;
};

export type HavenMcpWorkerEnv = {
  HAVEN_BASE_URL: string;
  HAVEN_MCP_SESSION: HavenDoNamespace;
  HAVEN_MCP_BUDGET: HavenDoNamespace;
  ANON_IP_LIMIT?: string;
  ANON_IP_WINDOW_MS?: string;
  ANON_GLOBAL_PROBE_CAP?: string;
  PROBE_TTL_MS?: string;
};

const HAVEN_SESSION_KEY = "haven_gateway_session";
const BUDGET_TIER_KEY = "budget_tier";
const BUDGET_STATE_KEY = "budget_state";
const BUDGET_DO_NAME = "global";

type BudgetTier = "probe" | "activated" | "released";

const json = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const budgetStub = (env: HavenMcpWorkerEnv): HavenDoStub => {
  const id = env.HAVEN_MCP_BUDGET.idFromName(BUDGET_DO_NAME);
  return env.HAVEN_MCP_BUDGET.get(id);
};

const budgetPost = async (
  env: HavenMcpWorkerEnv,
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> => {
  return budgetStub(env).fetch(
    new Request(`https://haven-mcp-budget${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
};

const readBudgetSnapshot = async (env: HavenMcpWorkerEnv): Promise<BudgetSnapshot> => {
  try {
    const res = await budgetStub(env).fetch(
      new Request("https://haven-mcp-budget/stats", { method: "GET" }),
    );
    if (!res.ok) {
      return { probeSessions: 0, activatedSessions: 0, rejectedNewSession: 0 };
    }
    return (await res.json()) as BudgetSnapshot;
  } catch {
    return { probeSessions: 0, activatedSessions: 0, rejectedNewSession: 0 };
  }
};

/**
 * Global coordinator for anonymous probe admits and health counters.
 */
export class HavenMcpBudget {
  private budget: SessionBudget | null = null;

  constructor(
    private readonly ctx: HavenDoState,
    private readonly env: HavenMcpWorkerEnv,
  ) {}

  private async load(): Promise<SessionBudget> {
    if (this.budget) return this.budget;
    const cfg = budgetConfigFromEnv(this.env);
    const stored = await this.ctx.storage.get<BudgetState>(BUDGET_STATE_KEY);
    this.budget = new SessionBudget(stored ?? emptyBudgetState(), cfg);
    return this.budget;
  }

  private async persist(): Promise<void> {
    if (!this.budget) return;
    await this.ctx.storage.put(BUDGET_STATE_KEY, this.budget.exportState());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const budget = await this.load();
    const now = Date.now();

    if (request.method === "GET" && url.pathname === "/stats") {
      return json(budget.snapshot());
    }

    if (request.method === "POST" && url.pathname === "/admit") {
      budget.pruneIpBuckets(now);
      const body = (await request.json().catch(() => ({}))) as { ip?: string };
      const ip = typeof body.ip === "string" && body.ip.length > 0 ? body.ip : "unknown";
      const result = budget.admit(ip, now);
      await this.persist();
      if (!result.ok) {
        return json(
          {
            ok: false,
            reason: result.reason,
            retryAfterSec: result.retryAfterSec,
            ...budget.snapshot(),
          },
          429,
          { "Retry-After": String(result.retryAfterSec) },
        );
      }
      return json({ ok: true, ...budget.snapshot() });
    }

    if (request.method === "POST" && url.pathname === "/activate") {
      budget.activate();
      await this.persist();
      return json({ ok: true, ...budget.snapshot() });
    }

    if (request.method === "POST" && url.pathname === "/release-probe") {
      budget.releaseProbe();
      await this.persist();
      return json({ ok: true, ...budget.snapshot() });
    }

    if (request.method === "POST" && url.pathname === "/release-activated") {
      budget.releaseActivated();
      await this.persist();
      return json({ ok: true, ...budget.snapshot() });
    }

    return json({ error: "NotFound" }, 404);
  }
}

/**
 * One Durable Object instance per MCP protocol session.
 * Sticky across requests; storage backs Haven gateway tokens.
 * Probe alarm TTL clears idle crawler sessions unless `hvs_…` exists.
 */
export class HavenMcpSession {
  private handler: ReturnType<typeof createHavenMcpHttpHandler> | null = null;
  private activatedNotified = false;

  constructor(
    private readonly ctx: HavenDoState,
    private readonly env: HavenMcpWorkerEnv,
  ) {}

  private probeTtlMs(): number {
    return budgetConfigFromEnv(this.env).probeTtlMs;
  }

  private async getTier(): Promise<BudgetTier> {
    const tier = await this.ctx.storage.get<BudgetTier>(BUDGET_TIER_KEY);
    return tier ?? "probe";
  }

  private async setTier(tier: BudgetTier): Promise<void> {
    await this.ctx.storage.put(BUDGET_TIER_KEY, tier);
  }

  private async notifyBudget(path: "/activate" | "/release-probe" | "/release-activated"): Promise<void> {
    try {
      await budgetPost(this.env, path);
    } catch {
      /* best-effort metrics; session path must not fail closed on budget DO */
    }
  }

  private async scheduleProbeAlarm(): Promise<void> {
    if (!this.ctx.storage.setAlarm) return;
    const tier = await this.getTier();
    if (tier !== "probe") return;
    const existing = this.ctx.storage.getAlarm ? await this.ctx.storage.getAlarm() : null;
    if (existing) return;
    await this.ctx.storage.setAlarm(Date.now() + this.probeTtlMs());
  }

  private async scheduleActivatedAlarm(expiresAt: string): Promise<void> {
    if (!this.ctx.storage.setAlarm) return;
    const at = Date.parse(expiresAt);
    if (!Number.isFinite(at)) {
      await this.ctx.storage.setAlarm?.(Date.now() + this.probeTtlMs());
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, at));
  }

  private async onHavenSessionSaved(session: StoredGatewaySession): Promise<void> {
    const tier = await this.getTier();
    if (tier === "probe" && !this.activatedNotified) {
      this.activatedNotified = true;
      await this.setTier("activated");
      await this.notifyBudget("/activate");
    }
    await this.scheduleActivatedAlarm(session.expiresAt);
  }

  private async onHavenSessionCleared(): Promise<void> {
    const tier = await this.getTier();
    if (tier === "released") return;
    await this.setTier("released");
    if (tier === "activated") {
      await this.notifyBudget("/release-activated");
    } else if (tier === "probe") {
      await this.notifyBudget("/release-probe");
    }
    if (this.ctx.storage.deleteAlarm) {
      await this.ctx.storage.deleteAlarm();
    }
  }

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
          await this.onHavenSessionSaved(session);
        },
        clear: async () => {
          await storage.delete(HAVEN_SESSION_KEY);
          await this.onHavenSessionCleared();
        },
      },
    });
    return this.handler;
  }

  /**
   * Probe TTL (or Haven expiry): drop idle crawler DOs; release budget slots.
   */
  async alarm(): Promise<void> {
    const tier = await this.getTier();
    if (tier === "released") return;

    const row = await this.ctx.storage.get<StoredGatewaySession>(HAVEN_SESSION_KEY);
    if (!row) {
      await this.setTier("released");
      if (tier === "probe") {
        await this.notifyBudget("/release-probe");
      } else if (tier === "activated") {
        await this.notifyBudget("/release-activated");
      }
      this.handler = null;
      return;
    }

    const expiresAt = Date.parse(row.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      await this.scheduleActivatedAlarm(row.expiresAt);
      return;
    }

    await this.ctx.storage.delete(HAVEN_SESSION_KEY);
    await this.setTier("released");
    await this.notifyBudget("/release-activated");
    this.handler = null;
  }

  async fetch(request: Request): Promise<Response> {
    const row = await this.ctx.storage.get<StoredGatewaySession>(HAVEN_SESSION_KEY);
    const tier = await this.getTier();
    // Heal crash between durable save and tier flip.
    if (row && tier === "probe") {
      await this.onHavenSessionSaved(row);
    } else if (tier === "probe") {
      await this.scheduleProbeAlarm();
    } else if (tier === "activated" && row) {
      await this.scheduleActivatedAlarm(row.expiresAt);
    }
    return this.getHandler().fetch(request);
  }
}

/**
 * Route MCP traffic to a Durable Object named by the MCP session id.
 * New sessions issue an id before the first initialize POST, after budget admit.
 */
export default {
  async fetch(request: Request, env: HavenMcpWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      const snapshot = await readBudgetSnapshot(env);
      return json({
        ok: true,
        name: "haven-mcp",
        transport: "streamable-http",
        havenBaseUrl: env.HAVEN_BASE_URL || "https://haven.chitmark.com",
        mcp: "/mcp",
        probeSessions: snapshot.probeSessions,
        activatedSessions: snapshot.activatedSessions,
        rejectedNewSession: snapshot.rejectedNewSession,
        probeTtlMs: budgetConfigFromEnv(env).probeTtlMs ?? DEFAULT_PROBE_TTL_MS,
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
      const ip = clientIpFromRequest(request);
      const admitRes = await budgetPost(env, "/admit", { ip });
      if (admitRes.status === 429) {
        const retryAfter = admitRes.headers.get("Retry-After") ?? "60";
        const body = await admitRes.json().catch(() => ({}));
        return json(
          {
            error: "RateLimited",
            message: "Anonymous MCP session budget exceeded. Retry later.",
            ...(typeof body === "object" && body !== null ? body : {}),
          },
          429,
          { "Retry-After": retryAfter },
        );
      }
      if (!admitRes.ok) {
        return json(
          { error: "BudgetUnavailable", message: "Session budget coordinator failed." },
          503,
        );
      }
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
