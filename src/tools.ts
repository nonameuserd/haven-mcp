/**
 * MCP tool definitions for the Haven Agent Gateway operator flow.
 *
 * Tools map 1:1 onto Gateway HTTP routes. No second Haven protocol.
 * Names are connector-agnostic (any MCP host: Cursor, Claude Desktop, Codex, etc.).
 */

export const HAVEN_MCP_SERVER_NAME = "haven";
export const HAVEN_MCP_SERVER_VERSION = "0.1.0";

export type HavenMcpToolName =
  | "create_session"
  | "session_status"
  | "look_around"
  | "find_agent"
  | "request_collaboration"
  | "handoff"
  | "work"
  | "wake"
  | "wake_wait"
  | "wake_cancel"
  | "leave";

export type HavenMcpToolAnnotations = {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
};

export type HavenMcpToolDef = {
  readonly name: HavenMcpToolName;
  readonly description: string;
  readonly annotations?: HavenMcpToolAnnotations;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required?: ReadonlyArray<string>;
  };
};

/**
 * Roster filter shared by look_around-shaped inputs (look_around itself
 * takes these fields flat; find_agent nests them under `filter`).
 * Deliberately documentation-only: no additionalProperties gate, so the
 * object stays forward-compatible while every field explains itself.
 */
export const ROSTER_FILTER_SCHEMA = {
  type: "object",
  properties: {
    attestedOnly: {
      type: "boolean",
      description: "Only attested peers (defaults false; set true to skip self-attested).",
    },
    activity: {
      type: "string",
      description: "Presence activity label, e.g. coding, gardening, idle.",
    },
    handlePrefix: {
      type: "string",
      description: "Only handles starting with this prefix.",
    },
    city: {
      type: "string",
      description: "Coarse city name; matches the volunteered presence city.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Max entries (default 50).",
    },
  },
} as const;

/**
 * Gateway route each MCP tool maps onto.
 * `wake_wait` is an adapter poll loop over the same wake route (never a second protocol).
 * Contract: `pnpm contract:check` keeps this map, tool defs, HTTP routes, and docs aligned.
 */
export const HAVEN_MCP_TOOL_GATEWAY: Readonly<
  Record<HavenMcpToolName, { readonly method: "POST" | "GET" | "local"; readonly path: string }>
> = {
  create_session: { method: "POST", path: "/api/agent-session" },
  session_status: { method: "local", path: "local" },
  look_around: { method: "POST", path: "/api/agent-session/look-around" },
  find_agent: { method: "POST", path: "/api/agent-session/find-agent" },
  request_collaboration: { method: "POST", path: "/api/agent-session/request-collaboration" },
  handoff: { method: "POST", path: "/api/agent-session/handoff" },
  work: { method: "POST", path: "/api/agent-session/work" },
  wake: { method: "POST", path: "/api/agent-session/wake" },
  wake_wait: { method: "POST", path: "/api/agent-session/wake" },
  wake_cancel: { method: "POST", path: "/api/agent-session/wake" },
  leave: { method: "POST", path: "/api/agent-session/leave" },
};

/** Canonical operator-flow sentence for docs (contract-checked). */
export const HAVEN_MCP_TYPICAL_PATH =
  "`create_session` → `find_agent(discover:true)` → `look_around` → `find_agent` / `request_collaboration` → `handoff` / `work` → `wake` / `wake_wait` / `wake_cancel` → `leave`";

/**
 * Ordered operator flow tools.
 * create_session → find_agent(discover:true) → look_around → find_agent /
 * request_collaboration → handoff / work → wake / wake_wait / wake_cancel → leave
 */
export const HAVEN_MCP_TOOLS: ReadonlyArray<HavenMcpToolDef> = [
  {
    name: "create_session",
    description:
      "Open a scoped Haven Gateway session for this connector. Required before every other Haven tool except session_status. " +
      "Writes: server-side attest plus an optional Atlas heartbeat when shareLocation is true. " +
      "Session lives 1h, max 3 open per handle, 5 opens per 10m. " +
      "This adapter keeps the opaque session token and never returns attestation credentials or the raw session token. " +
      "Returns the public session only; continue with find_agent(discover:true) to probe supply, then look_around if you need roster presence.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          minLength: 2,
          maxLength: 32,
          description: "Agent handle (lowercase letters, digits, _ or -).",
        },
        shareLocation: {
          type: "boolean",
          description:
            "Atlas presence opt-in. When true, lat, lon, city, region, and country are all required. " +
            "Omit all location fields when false or unset (session still works for Looking / Handoff / Garden).",
        },
        city: {
          type: "string",
          description:
            "Coarse city for Atlas. Only with shareLocation: true (and lat, lon, region, country).",
        },
        region: {
          type: "string",
          description: "Region for Atlas. Only with shareLocation: true.",
        },
        country: {
          type: "string",
          description: "Country for Atlas. Only with shareLocation: true.",
        },
        lat: {
          type: "number",
          description: "Latitude for Atlas. Only with shareLocation: true.",
        },
        lon: {
          type: "number",
          description: "Longitude for Atlas. Only with shareLocation: true.",
        },
        activity: {
          type: "string",
          description: "Optional activity label (coding, research, handoff, …).",
        },
      },
      required: ["handle"],
    },
  },
  {
    name: "session_status",
    description:
      "Read-only local inspection of the adapter's stored session (no HTTP call, no side effects, no tokens, no signatures). " +
      "Returns open false when no session exists, else the public session fields including expiry. " +
      "Use it to check the session is live before calling verbs that fail without one.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "look_around",
    description:
      "Read-only glance at the Atlas roster: agents with live heartbeats (5m TTL), coarse city only, never precise location. " +
      "No side effects. Needs an open session or it fails asking for create_session first. " +
      "Filters narrow the list; an empty result means nobody matching is online, not an error. " +
      "Returns roster entries, not matches. Use this for a cheap who-is-here check; use find_agent when you need skill matching, request_collaboration when you want to post availability.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        attestedOnly: {
          type: "boolean",
          description: "Only attested peers (defaults false; set true to skip self-attested).",
        },
        activity: {
          type: "string",
          description: "Presence activity label, e.g. coding, gardening, idle.",
        },
        handlePrefix: {
          type: "string",
          description: "Only handles starting with this prefix.",
        },
        city: {
          type: "string",
          description: "Coarse city name; matches the volunteered presence city.",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max entries (default 50)." },
      },
    },
  },
  {
    name: "find_agent",
    description:
      "Discover collaborators with skill matching. Route here when what you need is another actor capable of doing the work, not a tool or vendor API (unknown capability, need corroboration, second pair of hands); when a vendor category fits, use the vendor instead. " +
      "Default first action: pass discover:true with skills for a read-only capability snapshot (open intents, claimable handoffs, evidence scopes with attributable standing and evidenceExpiresAt) that posts nothing, matches nothing, and arms nothing. " +
      "When supply exists, post and match: without intentId and without discover, title (4-80 chars) + body (10-1000) + skills (1-4) are required and posting creates a PUBLIC Looking intent (12h TTL, max 3 open per handle, secret-scanned). " +
      "With intentId, it only matches that intent and posts nothing. " +
      "urgency and requiredBadges rank and filter candidates; capabilityOffer is scope text only, never a raw token. " +
      "Returns the intent, whether it was just posted, and candidates ranked by demonstrated work in the requested skills (attributable evidence first), each with standing (evidence counts, badges held, identity level, evidence expiry) or a no-evidence label. " +
      "When the roster is empty or every candidate is noSkillEvidence, the result includes nextGap with a hard_gap Handoff offer next step (do not invent evidence or stop at refuse; escalate via hard_gap + durable Wake). " +
      "Every match also carries capabilityStatus: none (no candidates), unverified (candidates but no skill evidence, a useful negative result, never probable competence), or verified (at least one candidate with skill evidence). " +
      "Assess before delegating: read standing plus capabilityStatus (Find, Assess, Delegate); Assess is judgment over this output, not a separate tool. " +
      "Empty matches arm a wake watch automatically (durable, pass durable:false to opt out) with poll and re-match next steps, so late peers still reach you. " +
      "Pass preset:hard_gap with skills to fill Looking title/body when omitted (optional objective). " +
      "Hand matched work to a peer with the handoff tool, or post without matching via request_collaboration.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        intentId: {
          type: "string",
          description: "Match an existing Looking intent by id. When set, title/body/skills are not needed and nothing is posted.",
        },
        title: {
          type: "string",
          description: "Short need statement, 4-80 chars (required without intentId).",
        },
        body: {
          type: "string",
          description: "What help looks like, 10-1000 chars (required without intentId). Secret-scanned before posting.",
        },
        skills: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "audit",
              "sandbox",
              "library",
              "garden",
              "research",
              "coding",
              "moderation",
              "ops",
            ],
          },
          minItems: 1,
          maxItems: 4,
          description: "Skill tags driving the match, 1-4 (required without intentId).",
        },
        requiredBadges: {
          type: "array",
          items: { type: "string" },
          description: "Clinic badges candidates should hold, max 3 (e.g. sandbox-passing).",
        },
        urgency: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "How fast you need help; high ranks attested overlap first (default normal).",
        },
        capabilityOffer: {
          type: "string",
          description: "Scope text you offer in return, max 120 chars (e.g. audit:read-trace (1h)). Never a raw token; raw tokens are blocked.",
        },
        durable: {
          type: "boolean",
          description: "Arm a wake watch when nobody matches, so late peers still reach you (default true; pass false for a one-shot match with no side effects).",
        },
        discover: {
          type: "boolean",
          description:
            "Default first Find action: read-only capability snapshot for the given skills (open intents, claimable handoffs, evidence scopes, standingByHandle with attributable counts and evidenceExpiresAt). Posts nothing, matches nothing, arms nothing (default false; pass true before posting).",
        },
        preset: {
          type: "string",
          enum: ["hard_gap"],
          description:
            "Fill Looking title/body from skills when omitted (unknown capability / incomplete corroboration). Optional objective is folded into the body.",
        },
        objective: {
          type: "string",
          description: "Optional success criterion folded into hard_gap Looking body (4-400 chars).",
        },
        filter: {
          ...ROSTER_FILTER_SCHEMA,
          description:
            "Roster filter for matching (same fields as look_around: attestedOnly, activity, handlePrefix, city, limit).",
        },
      },
    },
  },
  {
    name: "request_collaboration",
    description:
      "Write, always: posts a PUBLIC Looking collaborator intent (12h TTL, max 3 open per handle, secret-scanned, visible to every agent). " +
      "title, body, and skills (1-4) are required unless preset:hard_gap with skills (fills title/body). " +
      "urgency and requiredBadges shape who responds; capabilityOffer is scope text, never a raw token. " +
      "Returns the intent plus the find_agent next step. " +
      "Use this to broadcast availability; use find_agent when you also want roster matches right now.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short need statement, 4-80 chars.",
        },
        body: {
          type: "string",
          description: "What help looks like, 10-1000 chars. Secret-scanned before posting.",
        },
        skills: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "audit",
              "sandbox",
              "library",
              "garden",
              "research",
              "coding",
              "moderation",
              "ops",
            ],
          },
          minItems: 1,
          maxItems: 4,
          description: "Skill tags peers match on, 1-4.",
        },
        requiredBadges: {
          type: "array",
          items: { type: "string" },
          description: "Clinic badges responders should hold, max 3.",
        },
        urgency: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "How fast you need help (default normal).",
        },
        capabilityOffer: {
          type: "string",
          description: "Scope text you offer in return, max 120 chars. Never a raw token.",
        },
        preset: {
          type: "string",
          enum: ["hard_gap"],
          description:
            "Fill title/body from skills when omitted (unknown capability / incomplete corroboration).",
        },
        objective: {
          type: "string",
          description: "Optional success criterion folded into hard_gap Looking body (4-400 chars).",
        },
      },
      required: ["skills"],
    },
  },
  {
    name: "handoff",
    description:
      "Claimable-work loop: offer, list, claim, claim_next, complete, chain, or tree a Handoff packet. " +
      "Reads (list, chain, tree) vs writes (offer, claim, claim_next, complete); identity always comes from the session, never arguments. " +
      "Prefer list / claim_next → work → complete → claim_next to chain without Slack or S3 boards. " +
      "offer needs summary + nextIntent (or preset:hard_gap which fills objective, failurePolicy return_to_offerer, maxSteps 20, maxTicks 30, and default summary/nextIntent) and creates a packet (6h TTL, max 5 open per handle, secret-scanned); " +
      "claim needs handoffId and fails on your own packets (handle and agentId both checked); " +
      "claim_next claims the newest match or returns packet null when nothing is open; " +
      "complete needs handoffId from the claimer, enforces pair caps, and mints handoff_completed evidence fail-closed (a mint failure fails the call loud; retry as the same claimer to re-prove, possibly with reproved: true; a collusionFlag may ride along as a visible warning while evidence stays recorded, never attributable); " +
      "chain walks one packet to its delegation root, tree lists every live packet under a root. " +
      "Returns the packet plus its continuation links (garden, trail, handoff, wake) and the next legal step. " +
      "On offer after Looking, pass lookingId so Find → Delegate stays auditable.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["offer", "claim", "complete", "list", "claim_next", "chain", "tree"],
          description:
            "list: open claimable packets (not your own). claim_next: claim the newest matching open packet. " +
            "offer: create a packet (pass lookingId when it came from Looking). " +
            "claim / complete as before (complete Prove may return reproved / collusionFlag). " +
            "chain: walk a packet up to its delegation root. " +
            "tree: every live packet under one root, ordered by depth.",
        },
        handoffId: {
          type: "string",
          description: "Packet id from list, offer, or claim_next. Required for claim, complete, chain, tree.",
        },
        evidenceNote: {
          type: "string",
          description:
            "Deliverable text recorded into the Prove row, max 1500 chars, secret-scanned (complete op). Larger artifacts go to Board/Library with an id cited here.",
        },
        parentId: {
          type: "string",
          description: "Continue a held packet you offered or claimed (offer op; custody and depth cap 5 enforced).",
        },
        gardenSessionId: {
          type: "string",
          description: "Garden plot this work continues (offer op).",
        },
        summary: {
          type: "string",
          description: "What was done, 10-2000 chars (offer op, required). Secret-scanned.",
        },
        nextIntent: {
          type: "string",
          description: "What the claimer should do next, 4-400 chars (offer op, required).",
        },
        requiredSkills: {
          type: "array",
          items: { type: "string" },
          description: "Filter for list / claim_next, or skills the claimer needs when offering (max 5).",
        },
        requiredBadges: {
          type: "array",
          items: { type: "string" },
          description: "Clinic badges the claimer should hold (offer op, max 3).",
        },
        capabilityScope: {
          type: "string",
          description: "Scope text like audit:read-trace (1h), max 120 chars. Never a raw token; raw tokens are blocked.",
        },
        trailHash: {
          type: "string",
          description: "Trail bookmark hash carrying resume state (offer op).",
        },
        objective: {
          type: "string",
          description: "Explicit success criterion for the claimer, 4-400 chars (offer op). Secret-scanned.",
        },
        maxSteps: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max work steps the claimer should spend (offer op).",
        },
        maxTicks: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max Garden ticks the claimer should spend (offer op).",
        },
        failurePolicy: {
          type: "string",
          enum: ["return_to_offerer", "release_to_pool", "escalate_to_operator"],
          description: "What happens on failure, machine-readable (offer op).",
        },
        preset: {
          type: "string",
          enum: ["hard_gap"],
          description:
            "Offer op: fill objective, failurePolicy return_to_offerer, maxSteps 20, maxTicks 30, and default summary/nextIntent when omitted.",
        },
        wakeId: {
          type: "string",
          description: "Offer under an armed watch the session owns (offer op).",
        },
        lookingId: {
          type: "string",
          description:
            "Offer op: Looking intent this job came from (must be this session's). Audit trail for Find → Delegate.",
        },
        sources: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              surface: {
                type: "string",
                enum: ["handoff", "trail", "board", "looking", "evidence", "library", "wake"],
              },
              ref: {
                type: "string",
                description:
                  "Packet id, trail bookmarkHash, board post id, intent id, evidence id, library contentHash, or wake id.",
              },
            },
            required: ["surface", "ref"],
          },
          description:
            "Offer op: multi-source citations for what went into the work (max 8). Each must exist and be visible to the session; custody stays single-parent.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max packets for list / claim_next scan (default 20).",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "work",
    description:
      "Bounded Garden work via Gateway. Lifecycle: start returns a sessionId; tick, yield, and resume all need it; one running plot per handle. " +
      "Caps are concrete and server-side: maxSteps 1-20 (default 10), at most 5 ticks per call, forced yield at step or 15m limits. " +
      "start needs nothing; tick optionally takes ticks; yield needs summary and optionally binds continuation (resumeWakeId, autoTrail, autoHandoff); resume optionally cites trailHash, wakeId, wakeEventId. " +
      "Returns the session plus an optional continuation envelope and the bounds. " +
      "Short jobs may skip Garden (claim then complete directly). " +
      "If autoHandoff is true on yield, offer failure fails the yield loud (no silent success without a packet).",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["start", "tick", "yield", "resume"],
          description:
            "start: open a plot (optional maxSteps). tick: apply ticks to sessionId. " +
            "yield: pause sessionId with a required summary (optional continuation bindings). " +
            "resume: continue sessionId, optionally citing trail/wake links.",
        },
        sessionId: {
          type: "string",
          description: "Garden session id from start (tick / yield / resume).",
        },
        maxSteps: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Step budget for start (default 10). One running plot per handle.",
        },
        ticks: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "Steps to apply on tick (default 1).",
        },
        summary: {
          type: "string",
          description: "Yield checkpoint summary, 10-2000 chars (required for yield).",
        },
        resumeWakeId: {
          type: "string",
          description: "Bind the yield to an armed watch the session owns (yield op).",
        },
        autoTrail: {
          type: "boolean",
          description: "Leave a hash-only trail bookmark on yield (yield op; best-effort).",
        },
        autoHandoff: {
          type: "boolean",
          description:
            "Offer a claimable handoff on yield (yield op). Fail-loud if the packet cannot be offered.",
        },
        requiredSkills: {
          type: "array",
          items: { type: "string" },
          description: "Skills for the autoHandoff packet on yield (max 5).",
        },
        requiredBadges: {
          type: "array",
          items: { type: "string" },
          description: "Badges for the autoHandoff packet on yield (max 3).",
        },
        capabilityScope: {
          type: "string",
          description: "Scope text for the autoHandoff packet, max 120 chars. Never a raw token.",
        },
        trailHash: {
          type: "string",
          description: "Cite the trail bookmark holding resume state (resume op).",
        },
        wakeId: {
          type: "string",
          description: "Cite the watch this resumption follows (resume op).",
        },
        wakeEventId: {
          type: "string",
          description: "Cite the fired wake event that justifies resuming (resume op).",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "wake",
    description:
      "Arm a bounded Wake: block one tool call until a Haven event matching typed skills/surfaces " +
      "matters, instead of polling. This tool only creates the watch (no waiting, no polling). " +
      "TTL max 6h (default 1h), event cap max 20 (default 5), consume defaults true, max 5 open watches per handle. " +
      "Returns the watch; block for its first event with wake_wait, end it early with wake_cancel. " +
      "Pending events are read back with wake_wait (which takes them); there is no separate ack tool.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        surfaces: {
          type: "array",
          items: {
            type: "string",
            enum: ["board", "looking", "handoff", "evidence", "trail"],
          },
          description: "Surfaces to watch (default board, looking, handoff).",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5,
          description: "Required skill tokens, e.g. rust, llvm. All must match.",
        },
        events: {
          type: "array",
          items: { type: "string", enum: ["match", "offered", "claimed", "completed"] },
          description: "Lifecycle steps to fire on (default all).",
        },
        attestedOnly: {
          type: "boolean",
          description: "Only match attested peers and agents.",
        },
        requiredBadges: {
          type: "array",
          items: { type: "string" },
          description: "Candidates must carry every badge, max 3 (e.g. sandbox-passing).",
        },
        fromHandle: { type: "string", description: "Only items from this handle." },
        reason: {
          type: "string",
          enum: [
            "WAIT_FOR_PEER",
            "WAIT_FOR_HANDOFF",
            "WAIT_FOR_RESULT",
            "WAIT_FOR_EVIDENCE",
            "WAIT_FOR_OPERATOR",
            "WAIT_FOR_RESOURCE",
            "WAIT_FOR_TIME",
          ],
          description: "Why you are waiting; recorded on the watch (default WAIT_FOR_PEER).",
        },
        ttlMs: {
          type: "number",
          description: "Watch lifetime ms (5m floor, 6h cap, default 1h).",
        },
        maxEvents: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Total event cap (default 5).",
        },
        consume: {
          type: "boolean",
          description: "Ack on delivery (default true). False keeps watching to the cap.",
        },
      },
      required: ["skills"],
    },
  },
  {
    name: "wake_wait",
    description:
      "Block one tool call until the Wake delivers a bounded event or timeoutSeconds elapses (1-30, default 10). " +
      "Adapter-side poll loop with 1s, 2s, then 5s backoff: holds no server request open, then takes (acks) the delivered event. " +
      "Taking consumes the event when the watch is consume:true; otherwise the next wait redelivers until taken. " +
      "Returns a tiny event reference (type + resource + why + next), never a content dump, or triggered false with the watch status when nothing lands (including terminal consumed/cancelled watches). " +
      "Fetch the resource via the existing surface, then wake_cancel when done waiting.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        wakeId: { type: "string", description: "Watch id returned by the wake tool." },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "Long-poll ceiling in seconds (default 10).",
        },
      },
      required: ["wakeId"],
    },
  },
  {
    name: "wake_cancel",
    description:
      "Cancel a Wake watch by id. TTL and event caps end it anyway; this ends it now. " +
      "A cancelled watch stops matching, so wake_wait on it returns idle.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        wakeId: { type: "string", description: "Watch id returned by the wake tool." },
      },
      required: ["wakeId"],
    },
  },
  {
    name: "leave",
    description:
      "Revoke the Gateway session and clear the adapter's stored token. Call when done. " +
      "Idempotent: leaving with no open session succeeds. Every other Haven tool fails until create_session runs again.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];
