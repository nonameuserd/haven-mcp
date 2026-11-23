import { Haven, HavenApiError, HavenError } from "@chitmark/haven-agent";
import type {
  GatewayFindAgentInput,
  GatewayHandoffInput,
  GatewayOpenInput,
  GatewayOutcomeInput,
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
import { HAVEN_MCP_SERVER_VERSION, type HavenMcpToolName } from "./tools.js";

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
  readonly errorDetails?: {
    readonly status: number;
    readonly code: string;
    readonly retryAfterMs?: number;
  };
};

/**
 * Backoff delay before the next wake_wait poll, by completed polls so far.
 * Mirror of wakeWaitPollDelayMs in src/domain/Wake.ts (server domain code
 * is not importable from this package); pinned by the MCP unit test below.
 */
export const wakeWaitDelayMs = (completedPolls: number): number => {
  if (completedPolls <= 0) return 1000;
  if (completedPolls === 1) return 2000;
  return 5000;
};

/**
 * Thin bridge: MCP tool args → Haven Gateway HTTP via @chitmark/haven-agent.
 * Session tokens stay in `store`; tool results are scrubbed.
 */
export class HavenGatewayBridge {
  readonly store: GatewaySessionStore;
  private haven: Haven;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(opts: HavenGatewayBridgeOptions = {}) {
    this.store = opts.store ?? new GatewaySessionStore();
    this.baseUrl = (opts.baseUrl ?? "https://haven.chitmark.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.haven = new Haven({
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      clientName: `haven-mcp/${HAVEN_MCP_SERVER_VERSION}`,
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
      await this.store.flush();
      const observation = content as {
        followUp?: {
          requiresContinuation?: boolean;
          requiresAction?: boolean;
          state?: string;
        };
      } | null;
      if (
        observation?.followUp?.requiresContinuation ||
        observation?.followUp?.state === "rework_required" ||
        observation?.followUp?.state === "observation_unavailable"
      ) {
        const rework = observation.followUp.state === "rework_required";
        const blocked =
          observation.followUp.state === "observation_unavailable" &&
          observation.followUp.requiresAction;
        return {
          ok: false,
          content: scrubSensitiveFields(content),
          error: rework
            ? "ReworkRequired: delivery was rejected. Correct the work using the recorded feedback and remaining rounds."
            : blocked
              ? "ObservationBlocked: the write was recorded, but verdict access needs attention. Inspect session_status and the fixed waitError before continuing."
              : "WorkPending: this lifecycle still needs attention. Continue the nextToolCall packet wait; submission and timeout are not acceptance or permission to end the runtime.",
          errorDetails: {
            status: rework || blocked ? 409 : 202,
            code: rework
              ? "ReworkRequired"
              : blocked
                ? "ObservationBlocked"
                : "WorkPending",
          },
        };
      }
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
      return {
        ok: false,
        content: null,
        error: scrubSensitiveText(raw),
        ...(e instanceof HavenApiError
          ? {
              errorDetails: {
                status: e.status,
                code: scrubSensitiveText(e.error),
                ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
              },
            }
          : {}),
      };
    }
  }

  private async dispatch(
    name: HavenMcpToolName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case "list_capabilities":
        return this.listCapabilities(args);
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
      case "delegate":
        this.requireToken();
        return this.handoffLifecycle(args, true);
      case "handoff":
        this.requireToken();
        return this.handoffLifecycle(args);
      case "work":
        this.requireToken();
        return this.haven.gateway.work(args as unknown as GatewayWorkInput);
      case "create_swarm":
        this.requireToken();
        return this.swarmCreate(args);
      case "join_swarm":
        this.requireToken();
        return this.swarmJoin(args);
      case "leave_swarm":
        this.requireToken();
        return this.swarmLeave(args);
      case "renew_swarm":
        this.requireToken();
        return this.swarmRenew(args);
      case "list_worlds":
        // No session required, and that is the property: an agent decides where
        // to go before it authenticates anywhere.
        return this.worldList();
      case "join_world":
        this.requireToken();
        return this.worldJoin(args);
      case "report_outcome":
        this.requireToken();
        return this.haven.gateway.outcome(args as unknown as GatewayOutcomeInput);
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
        return this.leave(args.forgetResume === true, args.force === true);
      default: {
        const _exhaustive: never = name;
        throw new HavenError(`Unknown tool: ${String(_exhaustive)}`, {
          code: "validation",
        });
      }
    }
  }

  private async listCapabilities(args: Record<string, unknown>): Promise<unknown> {
    const policy =
      args.policy === "best" ||
      args.policy === "as_provided" ||
      args.policy === "constrained_best"
        ? args.policy
        : undefined;
    const task = typeof args.task === "string" ? args.task : undefined;
    const peers = Array.isArray(args.peers) ? (args.peers as never[]) : undefined;
    const includeHaven =
      typeof args.includeHaven === "boolean" ? args.includeHaven : undefined;
    const constraints =
      args.constraints &&
      typeof args.constraints === "object" &&
      !Array.isArray(args.constraints)
        ? (args.constraints as Record<string, string>)
        : undefined;
    const objective =
      args.objective &&
      typeof args.objective === "object" &&
      !Array.isArray(args.objective)
        ? (args.objective as {
            maximize?: string;
            minimize?: string;
            secondary?: string;
          })
        : undefined;
    const trustedVerifiers = Array.isArray(args.trustedVerifiers)
      ? (args.trustedVerifiers.filter((v) => typeof v === "string") as string[])
      : undefined;
    const asOf = typeof args.asOf === "string" ? args.asOf : undefined;
    const minProvenance =
      typeof args.minProvenance === "string" ? args.minProvenance : undefined;
    const needsRank =
      peers !== undefined ||
      includeHaven !== undefined ||
      constraints !== undefined ||
      objective !== undefined ||
      trustedVerifiers !== undefined ||
      asOf !== undefined ||
      minProvenance !== undefined ||
      policy === "constrained_best";
    if (needsRank) {
      return this.haven.capabilities.rank({
        ...(policy ? { policy } : {}),
        ...(task !== undefined ? { task } : {}),
        ...(peers !== undefined ? { peers: peers as never } : {}),
        ...(includeHaven !== undefined ? { includeHaven } : {}),
        ...(constraints !== undefined ? { constraints } : {}),
        ...(objective !== undefined ? { objective } : {}),
        ...(trustedVerifiers !== undefined ? { trustedVerifiers } : {}),
        ...(asOf !== undefined ? { asOf } : {}),
        ...(minProvenance !== undefined ? { minProvenance } : {}),
      });
    }
    return this.haven.capabilities.list({
      ...(policy ? { policy } : {}),
      ...(task !== undefined ? { task } : {}),
    });
  }

  private async handoffLifecycle(
    args: Record<string, unknown>,
    delegate = false,
  ): Promise<unknown> {
    const result = delegate
      ? await this.haven.gateway.delegate(args as never)
      : await this.haven.gateway.handoff(args as unknown as GatewayHandoffInput);
    const packet = result.packet as { id?: string; status?: string } | undefined;
    if (
      ((args.op === "complete" &&
        result.delivered === true &&
        packet?.status === "delivered") ||
        args.op === "offer" ||
        delegate) &&
      packet?.id
    ) {
      try {
        const observation = await this.haven.gateway.handoff({
          op: "wait",
          handoffId: packet.id,
          timeoutSeconds:
            typeof args.timeoutSeconds === "number"
              ? Math.min(30, Math.max(0, args.timeoutSeconds))
              : 20,
        });
        return {
          ...observation,
          ...(args.op === "offer" || delegate
            ? { offerRecorded: true, offer: result }
            : { deliveryRecorded: true, delivery: result }),
        };
      } catch (error) {
        const retryable =
          !(error instanceof HavenApiError) ||
          error.status >= 500 ||
          error.status === 429;
        return {
          ...result,
          ...(args.op === "offer" || delegate
            ? { offerRecorded: true }
            : { deliveryRecorded: true }),
          workComplete: false,
          followUp: {
            state: "observation_unavailable",
            workComplete: false,
            requiresContinuation: retryable,
            requiresAction: !retryable,
          },
          waitError:
            error instanceof HavenApiError
              ? { status: error.status, code: error.error }
              : { code: "TransportError" },
          nextToolCall: retryable
            ? {
                name: "handoff",
                arguments: { op: "wait", handoffId: packet.id, timeoutSeconds: 20 },
              }
            : { name: "session_status", arguments: {} },
        };
      }
    }
    return result;
  }

  private async createSession(args: Record<string, unknown>): Promise<unknown> {
    const handle = typeof args.handle === "string" ? args.handle : "";
    if (!handle) {
      throw new HavenError("create_session requires handle", { code: "validation" });
    }
    const input: GatewayOpenInput & { resumable?: boolean; resume?: boolean } = {
      handle,
      delivery: "header",
      ...(typeof args.arrivalSource === "string"
        ? { arrivalSource: args.arrivalSource as GatewayOpenInput["arrivalSource"] }
        : {}),
      ...(typeof args.arrivalReferrer === "string"
        ? { arrivalReferrer: args.arrivalReferrer }
        : {}),
      ...(typeof args.resumable === "boolean" ? { resumable: args.resumable } : {}),
      ...(typeof args.resume === "boolean" ? { resume: args.resume } : {}),
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
    const continuation = args.resume === true ? this.store.getResumeToken(handle) : null;
    if (args.resume === true && !continuation)
      throw new HavenError(
        "No live identity-resumption credential in this adapter. A handle alone cannot recover an identity.",
        { code: "validation" },
      );
    const issued = (await this.readJsonResponse(
      await this.fetchImpl(`${this.baseUrl}/api/agent-session`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(continuation ? { Authorization: `Haven-Resume ${continuation}` } : {}),
        },
        body: JSON.stringify(input),
      }),
    )) as {
      sessionId: string;
      handle: string;
      agentId: string;
      expiresAt: string;
      actions: string[];
      sessionToken: string;
      resumeToken?: string;
    };
    if (!issued.sessionToken)
      throw new HavenError("Gateway returned no session token", { code: "validation" });
    this.store.set({
      sessionId: issued.sessionId,
      handle: issued.handle,
      agentId: issued.agentId,
      expiresAt: issued.expiresAt,
      actions: issued.actions,
      sessionToken: issued.sessionToken,
      ...(issued.resumeToken ? { resumeToken: issued.resumeToken } : {}),
    });
    // Public view only: never include sessionToken.
    return {
      sessionId: issued.sessionId,
      handle: issued.handle,
      agentId: issued.agentId,
      expiresAt: issued.expiresAt,
      actions: issued.actions,
      resumable: !!issued.resumeToken,
      resumed: args.resume === true,
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
          "create_swarm",
          "join_swarm",
          "leave_swarm",
          "renew_swarm",
          "wake",
          "wake_wait",
          "wake_cancel",
          "leave",
        ],
        why: "Use find_agent(discover:true) first, then look_around if needed, then find_agent or request_collaboration, then handoff list/claim_next + work; open or join a swarm crew for multi-agent work (swarmId links packets and wakes); wake when idle, then leave.",
      },
    };
  }

  private sessionStatus(): unknown {
    const pub = this.store.getPublic();
    if (!pub || !this.store.hasSession()) {
      return {
        open: false,
        resumable: !!pub && !!this.store.getResumeToken(pub.handle),
        note: "No Gateway session. Use create_session with resume: true only when this adapter retained a live continuation.",
      };
    }
    return { open: true, ...pub };
  }

  /**
   * REST over the gateway session (Haven-Session auth, never attestation).
   * Thin 1:1 mapping onto a route; results are scrubbed by `call()`.
   *
   * Exists because the adapter cannot assume the published SDK wraps every route
   * it drives: `@chitmark/haven-agent` resolves from the registry, so a World
   * route added to the workspace SDK is invisible here until that version ships.
   * Rather than block M.2.1 on a publish, this is the same one-request mapping
   * the swarm tools already used, and it carries no identity of its own: the
   * session token in the header is the caller, which is why no tool can pass
   * someone else's handle here.
   */
  private async sessionRequest(
    path: string,
    method: "POST" | "GET" | "DELETE",
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const token = this.requireToken();
    return this.readJsonResponse(
      await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          Authorization: `Haven-Session ${token}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );
  }

  /**
   * M.2.2: a directory read that needs no session.
   *
   * Deliberately sends no `Authorization` header at all, even when a session is
   * open. `GET /api/worlds` is a public directory read and composes nothing from
   * the caller, so attaching a token would imply the answer depends on who asked
   * when it does not: it publishes each World's own admission, and the caller
   * pairs that with its own identity. A header that promises caller-specific
   * behaviour is a claim the route would then have to honour.
   */
  private async publicRequest(path: string): Promise<unknown> {
    return this.readJsonResponse(
      await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      }),
    );
  }

  /** Parse one Haven response, turning a 4xx/5xx into a scrubbed `HavenApiError`. */
  private async readJsonResponse(res: Response): Promise<unknown> {
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const b =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { error?: string; message?: string })
          : { message: String(parsed ?? `HTTP ${res.status}`) };
      throw new HavenApiError(res.status, {
        error: b.error,
        message: b.message ?? b.error,
      });
    }
    return parsed;
  }

  private async swarmCreate(args: Record<string, unknown>): Promise<unknown> {
    const name = typeof args.name === "string" ? args.name : "";
    const objective = typeof args.objective === "string" ? args.objective : "";
    if (!name || !objective) {
      throw new HavenError("create_swarm requires name and objective", {
        code: "validation",
      });
    }
    return this.sessionRequest("/api/agent-session/swarm", "POST", {
      op: "create",
      name,
      objective,
      ...(typeof args.attestedOnly === "boolean"
        ? { attestedOnly: args.attestedOnly }
        : {}),
      ...(typeof args.maxMembers === "number" ? { maxMembers: args.maxMembers } : {}),
    });
  }

  private swarmIdOf(args: Record<string, unknown>, tool: string): string {
    const id = typeof args.swarmId === "string" ? args.swarmId.trim() : "";
    if (!id) {
      throw new HavenError(`${tool} requires swarmId`, { code: "validation" });
    }
    return id;
  }

  private async swarmJoin(args: Record<string, unknown>): Promise<unknown> {
    return this.sessionRequest("/api/agent-session/swarm", "POST", {
      op: "join",
      swarmId: this.swarmIdOf(args, "join_swarm"),
    });
  }

  private async swarmLeave(args: Record<string, unknown>): Promise<unknown> {
    return this.sessionRequest("/api/agent-session/swarm", "POST", {
      op: "leave",
      swarmId: this.swarmIdOf(args, "leave_swarm"),
    });
  }

  private async swarmRenew(args: Record<string, unknown>): Promise<unknown> {
    return this.sessionRequest("/api/agent-session/swarm", "POST", {
      op: "renew",
      swarmId: this.swarmIdOf(args, "renew_swarm"),
    });
  }

  /**
   * M.2.1: drop into an existing World, identity from the session.
   *
   * The SDK call, not a hand-built fetch, because `Haven.world.join` is where
   * the identity requirement lives and a second fetch path here would be a second
   * place to forget it. Role is passed through only when the caller asked for
   * one, so the server default (member) stays the server's decision.
   */
  /**
   * M.2.2: the ledger read, one row per live World.
   *
   * Thin pass-through on purpose. The adapter does not filter to enterable rows
   * or reshape the admission terms: a second interpretation here would be a
   * second catalogue that can disagree with `GET /api/worlds`, which is the one
   * read the item names.
   */
  private async worldList(): Promise<unknown> {
    return this.publicRequest("/api/worlds");
  }

  private async worldJoin(args: Record<string, unknown>): Promise<unknown> {
    const worldId = typeof args.worldId === "string" ? args.worldId.trim() : "";
    if (!worldId) {
      throw new HavenError("join_world needs a worldId.", { code: "validation" });
    }
    const role =
      args.role === "member" || args.role === "observer" ? args.role : undefined;
    // No handle and no agentId in the body, ever. Identity is the session, so a
    // prompt that puts someone else's handle in the arguments has nowhere to put
    // it.
    return this.sessionRequest(
      `/api/worlds/${encodeURIComponent(worldId)}/join`,
      "POST",
      {
        ...(role ? { role } : {}),
      },
    );
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
    if (typeof args.swarmId === "string" && args.swarmId.trim().length > 0) {
      (input as unknown as Record<string, unknown>).swarmId = args.swarmId.trim();
    }
    return this.haven.gateway.wake(input);
  }

  /**
   * wake_wait: adapter-side poll loop over gateway poll passes.
   * Holds no server request open: polls with 1s, 2s, then 5s backoff until
   * a pending event lands or timeoutSeconds elapses, then acks the taken
   * event (ack what you processed) and returns the tiny reference.
   * Terminal watch states (consumed, cancelled, expired) return idle
   * instead of throwing. Session token never leaves the adapter.
   *
   * Backoff mirrors wakeWaitPollDelayMs in src/domain/Wake.ts (the adapter
   * cannot import server domain code); the MCP unit test pins the sequence.
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
    let completedPolls = 0;
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
      await new Promise((r) => setTimeout(r, wakeWaitDelayMs(completedPolls)));
      completedPolls += 1;
    }
  }

  private async leave(forgetResume = false, force = false): Promise<unknown> {
    if (!this.store.hasSession()) {
      if (forgetResume && this.store.getPublic())
        throw new HavenError(
          "Resume first, then leave with forgetResume: true to revoke continuation server-side.",
          { code: "validation" },
        );
      return { ok: true, note: "No session was open." };
    }
    this.requireToken();
    try {
      const left = (await this.sessionRequest("/api/agent-session/leave", "POST", {
        forgetResume,
        force,
      })) as unknown as {
        ok: true;
        handle: string;
        receipt?: unknown;
      };
      this.store.endSession(forgetResume);
      // Resume receipt: swarms, held packets and intents, wakes, trails,
      // expiries, returnTo paths, docs pointers. Scrubbed by call().
      return {
        ok: true,
        handle: left.handle,
        resumable: !!this.store.getResumeToken(left.handle),
        ...(left.receipt !== undefined ? { receipt: left.receipt } : {}),
      };
    } catch (e) {
      if (e instanceof HavenApiError && e.status === 401) {
        this.store.endSession();
        await this.store.flush();
      }
      throw e;
    }
  }
}
