import { Haven, HavenApiError, HavenError } from "@chitmark/haven-agent";
import type {
  GatewayFindAgentInput,
  GatewayHandoffInput,
  GatewayOpenInput,
  GatewayRequestCollaborationInput,
  GatewayWakeInput,
  GatewayWorkInput,
  RosterFilter,
} from "@chitmark/haven-agent";
import {
  GatewaySessionStore,
  scrubSensitiveFields,
  scrubSensitiveText,
} from "./session.js";
import type { HavenMcpToolName } from "./tools.js";

export type HavenGatewayBridgeOptions = {
  /** Haven origin (default HAVEN_BASE_URL or https://haven.chitmark.com). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Injected store (tests). */
  store?: GatewaySessionStore;
};

export type ToolCallResult = {
  readonly ok: boolean;
  readonly content: unknown;
  readonly error?: string;
};

/**
 * Thin bridge: MCP tool args → Haven Gateway HTTP via @chitmark/haven-agent.
 * Session tokens stay in `store`; tool results are scrubbed.
 */
export class HavenGatewayBridge {
  readonly store: GatewaySessionStore;
  private haven: Haven;

  constructor(opts: HavenGatewayBridgeOptions = {}) {
    this.store = opts.store ?? new GatewaySessionStore();
    this.haven = new Haven({
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      clientName: "haven-mcp/0.1.0",
    });
  }

  /** Require an open session and sync the SDK's in-memory gateway token. */
  private requireToken(): string {
    const token = this.store.getToken();
    if (!token) {
      throw new HavenError("No Gateway session. Call create_session first.", {
        code: "validation",
      });
    }
    this.haven.gateway.useToken(token);
    return token;
  }

  async call(
    name: HavenMcpToolName,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    try {
      const content = await this.dispatch(name, args);
      return { ok: true, content: scrubSensitiveFields(content) };
    } catch (e) {
      const raw =
        e instanceof HavenApiError
          ? e.message || `HTTP ${e.status}`
          : e instanceof HavenError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e);
      // Errors must never carry hvs_… or attestation material into LLM context.
      return { ok: false, content: null, error: scrubSensitiveText(raw) };
    }
  }

  private async dispatch(
    name: HavenMcpToolName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case "create_session":
        return this.createSession(args);
      case "session_status":
        return this.sessionStatus();
      case "look_around":
        this.requireToken();
        return this.haven.gateway.lookAround(args as RosterFilter);
      case "find_agent":
        this.requireToken();
        return this.haven.gateway.findAgent(args as GatewayFindAgentInput);
      case "request_collaboration":
        this.requireToken();
        return this.haven.gateway.requestCollaboration(
          args as unknown as GatewayRequestCollaborationInput,
        );
      case "handoff":
        this.requireToken();
        return this.haven.gateway.handoff(args as unknown as GatewayHandoffInput);
      case "work":
        this.requireToken();
        return this.haven.gateway.work(args as unknown as GatewayWorkInput);
      case "wake":
        this.requireToken();
        return this.wake(args);
      case "wake_wait":
        this.requireToken();
        return this.wakeWait(args);
      case "wake_cancel":
        this.requireToken();
        return this.haven.gateway.wake({
          op: "cancel",
          wakeId: args.wakeId as string,
        });
      case "leave":
        return this.leave();
      default: {
        const _exhaustive: never = name;
        throw new HavenError(`Unknown tool: ${String(_exhaustive)}`, {
          code: "validation",
        });
      }
    }
  }

  private async createSession(args: Record<string, unknown>): Promise<unknown> {
    const handle = typeof args.handle === "string" ? args.handle : "";
    if (!handle) {
      throw new HavenError("create_session requires handle", { code: "validation" });
    }
    const input: GatewayOpenInput = {
      handle,
      delivery: "header",
      ...(typeof args.shareLocation === "boolean"
        ? { shareLocation: args.shareLocation }
        : {}),
      ...(typeof args.city === "string" ? { city: args.city } : {}),
      ...(typeof args.region === "string" ? { region: args.region } : {}),
      ...(typeof args.country === "string" ? { country: args.country } : {}),
      ...(typeof args.lat === "number" ? { lat: args.lat } : {}),
      ...(typeof args.lon === "number" ? { lon: args.lon } : {}),
      ...(typeof args.activity === "string"
        ? { activity: args.activity as GatewayOpenInput["activity"] }
        : {}),
    };
    const issued = await this.haven.gateway.open(input);
    this.store.set({
      sessionId: issued.sessionId,
      handle: issued.handle,
      agentId: issued.agentId,
      expiresAt: issued.expiresAt,
      actions: issued.actions,
      sessionToken: issued.sessionToken,
    });
    // Public view only: never include sessionToken.
    return {
      sessionId: issued.sessionId,
      handle: issued.handle,
      agentId: issued.agentId,
      expiresAt: issued.expiresAt,
      actions: issued.actions,
      auth: {
        note: "Session token is held by the Haven MCP adapter. It is not returned to the host or model.",
      },
      next: {
        tools: [
          "look_around",
          "find_agent",
          "request_collaboration",
          "handoff",
          "work",
          "wake",
          "wake_wait",
          "wake_cancel",
          "leave",
        ],
        why: "Use look_around, then find_agent or request_collaboration, then handoff list/claim_next + work; wake when idle, then leave.",
      },
    };
  }

  private sessionStatus(): unknown {
    const pub = this.store.getPublic();
    if (!pub) {
      return { open: false, note: "No Gateway session. Call create_session." };
    }
    return { open: true, ...pub };
  }

  /**
   * wake: arm a watch via the gateway (identity from session).
   * Skills are required; everything else is an explicit bound.
   */
  private async wake(args: Record<string, unknown>): Promise<unknown> {
    const skills = Array.isArray(args.skills) ? (args.skills as string[]) : [];
    if (skills.length === 0) {
      throw new HavenError("wake requires skills", { code: "validation" });
    }
    const input: GatewayWakeInput = {
      op: "watch",
      skills,
      ...(Array.isArray(args.surfaces) ? { surfaces: args.surfaces as never } : {}),
      ...(Array.isArray(args.events) ? { events: args.events as never } : {}),
      ...(typeof args.attestedOnly === "boolean"
        ? { attestedOnly: args.attestedOnly }
        : {}),
      ...(Array.isArray(args.requiredBadges)
        ? { requiredBadges: args.requiredBadges as string[] }
        : {}),
      ...(typeof args.fromHandle === "string" ? { fromHandle: args.fromHandle } : {}),
      ...(typeof args.reason === "string" ? { reason: args.reason as never } : {}),
      ...(typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {}),
      ...(typeof args.maxEvents === "number" ? { maxEvents: args.maxEvents } : {}),
      ...(typeof args.consume === "boolean" ? { consume: args.consume } : {}),
    };
    return this.haven.gateway.wake(input);
  }

  /**
   * wake_wait: adapter-side poll loop over gateway poll passes.
   * Holds no server request open: polls about once a second until a pending
   * event lands or timeoutSeconds elapses, then acks the taken event (ack
   * what you processed) and returns the tiny reference. Terminal watch
   * states (consumed, cancelled, expired) return idle instead of throwing.
   * Session token never leaves the adapter.
   */
  private async wakeWait(args: Record<string, unknown>): Promise<unknown> {
    const wakeId = typeof args.wakeId === "string" ? args.wakeId : "";
    if (!wakeId) {
      throw new HavenError("wake_wait requires wakeId", { code: "validation" });
    }
    const timeoutSeconds = Math.min(
      Math.max(
        typeof args.timeoutSeconds === "number" ? Math.floor(args.timeoutSeconds) : 10,
        1,
      ),
      30,
    );
    const deadline = Date.now() + timeoutSeconds * 1000;
    type PollEvent = {
      id?: string;
      type?: string;
      resourceType?: string;
      resourceId?: string;
      why?: string[];
      next?: { method: string; path: string };
      from?: string;
    };
    type PollResult = {
      subscription?: { id: string; status: string; expiresAt: string };
      newEvents?: PollEvent[];
      pending?: PollEvent[];
    };
    const terminalOf = (message: string): string | null => {
      const m = message.toLowerCase();
      if (m.includes("consumed")) return "consumed";
      if (m.includes("cancelled")) return "cancelled";
      if (m.includes("expired")) return "expired";
      return null;
    };
    while (true) {
      let polled: PollResult;
      try {
        polled = (await this.haven.gateway.wake({
          op: "poll",
          wakeId,
        })) as unknown as PollResult;
      } catch (e) {
        const terminal = terminalOf(e instanceof Error ? e.message : String(e));
        if (terminal) return { wakeId, triggered: false, status: terminal };
        throw e;
      }
      const pending = Array.isArray(polled.pending) ? polled.pending : [];
      const first = pending[0];
      if (first?.id) {
        let status = polled.subscription?.status;
        try {
          const acked = (await this.haven.gateway.wake({
            op: "ack",
            wakeId,
            eventIds: [first.id],
          })) as unknown as PollResult;
          status = acked.subscription?.status ?? status;
        } catch {
          // At-least-once: the event is already taken for the caller even if
          // the ack did not land; the next wait will redeliver until acked.
        }
        return {
          wakeId,
          triggered: true,
          event: { type: first.type, resource: first.resourceId },
          why: first.why ?? [],
          next: first.next,
          from: first.from,
          status,
        };
      }
      const status = polled.subscription?.status;
      if (status === "consumed" || status === "cancelled") {
        return { wakeId, triggered: false, status };
      }
      if (Date.now() >= deadline) {
        return { wakeId, triggered: false, status };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private async leave(): Promise<unknown> {
    if (!this.store.hasSession()) {
      return { ok: true, note: "No session was open." };
    }
    this.requireToken();
    try {
      const left = await this.haven.gateway.leave();
      this.store.clear();
      return { ok: true, handle: left.handle };
    } catch (e) {
      this.store.clear();
      throw e;
    }
  }
}
