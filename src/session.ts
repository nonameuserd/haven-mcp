/**
 * Server-side gateway session store for the MCP adapter.
 *
 * Opaque `hvs_…` tokens stay here and are never returned to MCP hosts or LLMs.
 * Haven attestation signatures never enter this store.
 */

export type StoredGatewaySession = {
  /** Public session id from Haven Gateway. */
  readonly sessionId: string;
  readonly handle: string;
  readonly agentId: string;
  readonly expiresAt: string;
  readonly actions: ReadonlyArray<string>;
  /** Opaque Haven-Session token. Never serialize to tool results. */
  readonly sessionToken: string;
};

/** Optional persistence hooks (Durable Object / KV). Sync API stays for stdio. */
export type GatewaySessionStoreHooks = {
  readonly onSet?: (session: StoredGatewaySession) => void | Promise<void>;
  readonly onClear?: () => void | Promise<void>;
};

/**
 * In-memory session holder for one MCP connection (or process).
 * Remote HTTP workers attach hooks so tokens also land in DO / KV storage.
 */
export class GatewaySessionStore {
  private current: StoredGatewaySession | null = null;
  private readonly hooks: GatewaySessionStoreHooks;

  constructor(hooks: GatewaySessionStoreHooks = {}) {
    this.hooks = hooks;
  }

  /** Hydrate from durable storage after isolate / DO wake. */
  hydrate(session: StoredGatewaySession | null): void {
    this.current = session;
  }

  /** Store a gateway session after open. Replaces any prior session. */
  set(session: StoredGatewaySession): void {
    this.current = session;
    void this.hooks.onSet?.(session);
  }

  /** Public view only (no sessionToken). */
  getPublic(): Omit<StoredGatewaySession, "sessionToken"> | null {
    if (!this.current) return null;
    const { sessionToken: _omit, ...pub } = this.current;
    return pub;
  }

  /** Opaque token for Gateway Authorization. Never expose via tools. */
  getToken(): string | null {
    return this.current?.sessionToken ?? null;
  }

  hasSession(): boolean {
    return this.current !== null;
  }

  clear(): void {
    this.current = null;
    void this.hooks.onClear?.();
  }
}

/** Keys that must never appear in MCP tool results (case-insensitive). */
const SENSITIVE_KEYS = new Set([
  "sessiontoken",
  "session_token",
  "signature",
  "token",
  "havensession",
  "authorization",
  "attestation",
  "attestationsignature",
  "attestation_signature",
  "rawtoken",
  "raw_token",
]);

/**
 * Strip any accidental token/signature fields from Gateway JSON before
 * returning it as an MCP tool result.
 *
 * Removes sensitive keys and redacts string values that look like opaque
 * session tokens (`hvs_…`) or bare attestation-style hex blobs.
 */
export const scrubSensitiveFields = (value: unknown): unknown => {
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubSensitiveFields);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (SENSITIVE_KEYS.has(key)) {
        continue;
      }
      out[k] = scrubSensitiveFields(v);
    }
    return out;
  }
  return value;
};

/** Scrub free-text error messages the same way as tool payloads. */
export const scrubSensitiveText = (text: string): string => redactSensitiveString(text);

/** True when serialized tool output still contains secret material (red-team check). */
export const toolResultLeaksSecrets = (value: unknown): boolean => {
  const blob = typeof value === "string" ? value : JSON.stringify(value);
  if (!blob) return false;
  if (/\bhvs_[A-Za-z0-9_-]{8,}\b/.test(blob)) return true;
  if (/"signature"\s*:/.test(blob)) return true;
  if (/"sessionToken"\s*:/i.test(blob)) return true;
  if (/\bHaven-Session\s+hvs_/i.test(blob)) return true;
  if (/\bHaven\s+agt_[A-Za-z0-9_]+\s+[A-Za-z0-9+/=_-]{16,}\b/.test(blob)) return true;
  if (/\bHaven\s+agt_[A-Za-z0-9_]+\b/.test(blob)) return true;
  return false;
};

const redactSensitiveString = (s: string): string => {
  let out = s.replace(/\bhvs_[A-Za-z0-9_-]{8,}\b/g, "[redacted-session]");
  // Full attestation Authorization form: Haven <agentId> <signature>
  out = out.replace(
    /\bHaven\s+agt_[A-Za-z0-9_]+\s+[A-Za-z0-9+/=_-]{16,}\b/gi,
    "[redacted-attestation]",
  );
  // Attestation Authorization form must never appear in connector tool output.
  out = out.replace(/\bHaven\s+agt_[A-Za-z0-9_]+\b/gi, "[redacted-attestation]");
  out = out.replace(
    /\bHaven-Session\s+\[redacted-session\]/gi,
    "Haven-Session [redacted-session]",
  );
  out = out.replace(/\bagt_[A-Za-z0-9_]{6,}\b/g, "[redacted-agent]");
  // Long hex blobs that look like attestation/hash material in free text.
  out = out.replace(/\b[a-f0-9]{64}\b/gi, "[redacted-hash]");
  return out;
};
