import { afterEach, describe, expect, it, vi } from "vitest";
import { HavenMcpSession, type HavenMcpWorkerEnv } from "../src/worker.js";

const fixture = (expiresAt: string) => {
  const row = {
    sessionId: "lease",
    handle: "lease",
    agentId: "agt_lease",
    actions: [],
    sessionToken: "hvs_alarm_fixture",
    expiresAt,
  };
  const rows = new Map<string, unknown>([
    ["haven_gateway_session", row],
    ["budget_tier", "activated"],
  ]);
  let alarm: number | null = null;
  const storage = {
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      rows.set(key, value);
    },
    delete: async (key: string) => rows.delete(key),
    setAlarm: async (at: number) => {
      alarm = at;
    },
    getAlarm: async () => alarm,
  };
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({ fetch: async () => Response.json({ ok: true }) }),
  };
  const env: HavenMcpWorkerEnv = {
    HAVEN_BASE_URL: "https://haven.invalid",
    HAVEN_MCP_SESSION: namespace,
    HAVEN_MCP_BUDGET: namespace,
  };
  return { object: new HavenMcpSession({ storage }, env), rows, alarm: () => alarm, row };
};

afterEach(() => vi.useRealTimers());

describe("activated MCP session alarms", () => {
  it("retains the live credential if a four-minute probe alarm fires", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-11-23T00:00:00Z");
    vi.setSystemTime(start);
    const expiresAt = new Date(start + 3_600_000).toISOString();
    const state = fixture(expiresAt);
    vi.setSystemTime(start + 240_000);
    await state.object.alarm();
    expect(state.rows.get("haven_gateway_session")).toEqual(state.row);
    expect(state.rows.get("budget_tier")).toBe("activated");
    expect(state.alarm()).toBe(Date.parse(expiresAt));
  });

  it("purges the credential at lease expiry instead of extending it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-23T01:00:00Z"));
    const state = fixture("2026-11-23T00:59:59Z");
    await state.object.alarm();
    expect(state.rows.has("haven_gateway_session")).toBe(false);
    expect(state.rows.get("budget_tier")).toBe("released");
  });
});
