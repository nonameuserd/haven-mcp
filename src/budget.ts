/**
 * Anonymous MCP session budget: separate probe traffic from activated agents.
 *
 * Probe = initialize/tools/list with no Haven `hvs_…` yet.
 * Activated = `create_session` stored a gateway token.
 *
 * Pure logic (no Cloudflare imports) so Node tests and the budget DO share one path.
 */

export type BudgetConfig = {
  /** Max new probe sessions per IP per window. */
  readonly ipLimit: number;
  /** Sliding/fixed window length for per-IP new-session admits. */
  readonly ipWindowMs: number;
  /** Max concurrent probe sessions globally. */
  readonly globalProbeCap: number;
};

export type BudgetSnapshot = {
  readonly probeSessions: number;
  readonly activatedSessions: number;
  readonly rejectedNewSession: number;
};

export type AdmitRejectReason = "ip_limit" | "global_probe_cap";

export type AdmitResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AdmitRejectReason;
      readonly retryAfterSec: number;
    };

export type IpBucket = {
  windowStartMs: number;
  count: number;
};

export type BudgetState = {
  probeSessions: number;
  activatedSessions: number;
  rejectedNewSession: number;
  /** ipBucketKey → window counter */
  ipBuckets: Record<string, IpBucket>;
};

/** Default probe idle TTL (middle of 3–5 min). */
export const DEFAULT_PROBE_TTL_MS = 4 * 60 * 1000;

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  ipLimit: 20,
  ipWindowMs: 5 * 60 * 1000,
  globalProbeCap: 100,
};

export const emptyBudgetState = (): BudgetState => ({
  probeSessions: 0,
  activatedSessions: 0,
  rejectedNewSession: 0,
  ipBuckets: {},
});

/**
 * Stable short key for an IP (no crypto dependency; fine for rate buckets).
 */
export const ipBucketKey = (ip: string): string => {
  let hash = 5381;
  for (let i = 0; i < ip.length; i += 1) {
    hash = (hash * 33) ^ ip.charCodeAt(i);
  }
  return `ip:${(hash >>> 0).toString(16)}`;
};

const clampNonNeg = (n: number): number => (n > 0 ? n : 0);

/**
 * In-memory session budget. Persist `exportState()` from the Durable Object.
 */
export class SessionBudget {
  private readonly config: BudgetConfig;
  private state: BudgetState;

  constructor(
    state: BudgetState = emptyBudgetState(),
    config: BudgetConfig = DEFAULT_BUDGET_CONFIG,
  ) {
    this.state = {
      probeSessions: clampNonNeg(state.probeSessions),
      activatedSessions: clampNonNeg(state.activatedSessions),
      rejectedNewSession: clampNonNeg(state.rejectedNewSession),
      ipBuckets: { ...state.ipBuckets },
    };
    this.config = config;
  }

  exportState(): BudgetState {
    return {
      probeSessions: this.state.probeSessions,
      activatedSessions: this.state.activatedSessions,
      rejectedNewSession: this.state.rejectedNewSession,
      ipBuckets: { ...this.state.ipBuckets },
    };
  }

  snapshot(): BudgetSnapshot {
    return {
      probeSessions: this.state.probeSessions,
      activatedSessions: this.state.activatedSessions,
      rejectedNewSession: this.state.rejectedNewSession,
    };
  }

  /**
   * Admit a new MCP protocol session (no mcp-session-id yet).
   * Increments probeSessions on success.
   */
  admit(ip: string, nowMs: number): AdmitResult {
    if (this.state.probeSessions >= this.config.globalProbeCap) {
      this.state.rejectedNewSession += 1;
      return {
        ok: false,
        reason: "global_probe_cap",
        retryAfterSec: Math.max(1, Math.ceil(this.config.ipWindowMs / 1000)),
      };
    }

    const key = ipBucketKey(ip);
    const bucket = this.state.ipBuckets[key];
    if (!bucket || nowMs - bucket.windowStartMs >= this.config.ipWindowMs) {
      this.state.ipBuckets[key] = { windowStartMs: nowMs, count: 1 };
    } else if (bucket.count >= this.config.ipLimit) {
      this.state.rejectedNewSession += 1;
      const retryAfterSec = Math.max(
        1,
        Math.ceil((bucket.windowStartMs + this.config.ipWindowMs - nowMs) / 1000),
      );
      return { ok: false, reason: "ip_limit", retryAfterSec };
    } else {
      bucket.count += 1;
    }

    this.state.probeSessions += 1;
    return { ok: true };
  }

  /** Probe obtained a Haven `hvs_…` session. Idempotent. */
  activate(): void {
    if (this.state.probeSessions > 0) {
      this.state.probeSessions -= 1;
    }
    this.state.activatedSessions += 1;
  }

  /** Probe expired or closed without activation. Idempotent-ish (floors at 0). */
  releaseProbe(): void {
    this.state.probeSessions = clampNonNeg(this.state.probeSessions - 1);
  }

  /** Activated session left or expired. */
  releaseActivated(): void {
    this.state.activatedSessions = clampNonNeg(this.state.activatedSessions - 1);
  }

  /** Drop stale IP windows (optional maintenance). */
  pruneIpBuckets(nowMs: number): void {
    const next: Record<string, IpBucket> = {};
    for (const [key, bucket] of Object.entries(this.state.ipBuckets)) {
      if (nowMs - bucket.windowStartMs < this.config.ipWindowMs * 2) {
        next[key] = bucket;
      }
    }
    this.state.ipBuckets = next;
  }
}

/**
 * Resolve client IP for Worker rate limits.
 */
export const clientIpFromRequest = (request: Request): string => {
  const cf = request.headers.get("CF-Connecting-IP")?.trim();
  if (cf) return cf;
  const xff = request.headers.get("X-Forwarded-For")?.trim();
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
};

export const budgetConfigFromEnv = (env: {
  ANON_IP_LIMIT?: string;
  ANON_IP_WINDOW_MS?: string;
  ANON_GLOBAL_PROBE_CAP?: string;
  PROBE_TTL_MS?: string;
}): BudgetConfig & { probeTtlMs: number } => {
  const num = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    ipLimit: num(env.ANON_IP_LIMIT, DEFAULT_BUDGET_CONFIG.ipLimit),
    ipWindowMs: num(env.ANON_IP_WINDOW_MS, DEFAULT_BUDGET_CONFIG.ipWindowMs),
    globalProbeCap: num(env.ANON_GLOBAL_PROBE_CAP, DEFAULT_BUDGET_CONFIG.globalProbeCap),
    probeTtlMs: num(env.PROBE_TTL_MS, DEFAULT_PROBE_TTL_MS),
  };
};
