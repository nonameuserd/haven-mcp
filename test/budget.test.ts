import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_CONFIG,
  SessionBudget,
  emptyBudgetState,
  ipBucketKey,
} from "../src/budget.js";

describe("SessionBudget", () => {
  it("admits probes under the global cap and per-IP window", () => {
    const budget = new SessionBudget(emptyBudgetState(), {
      ...DEFAULT_BUDGET_CONFIG,
      ipLimit: 2,
      ipWindowMs: 60_000,
      globalProbeCap: 10,
    });
    const now = 1_000_000;
    expect(budget.admit("1.1.1.1", now)).toEqual({ ok: true });
    expect(budget.admit("1.1.1.1", now + 1)).toEqual({ ok: true });
    const rejected = budget.admit("1.1.1.1", now + 2);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toBe("ip_limit");
      expect(rejected.retryAfterSec).toBeGreaterThan(0);
    }
    expect(budget.snapshot()).toEqual({
      probeSessions: 2,
      activatedSessions: 0,
      rejectedNewSession: 1,
    });
  });

  it("rejects when the global probe cap is full", () => {
    const budget = new SessionBudget(emptyBudgetState(), {
      ipLimit: 100,
      ipWindowMs: 60_000,
      globalProbeCap: 2,
    });
    expect(budget.admit("1.1.1.1", 0).ok).toBe(true);
    expect(budget.admit("2.2.2.2", 0).ok).toBe(true);
    const rejected = budget.admit("3.3.3.3", 0);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe("global_probe_cap");
    expect(budget.snapshot().rejectedNewSession).toBe(1);
  });

  it("moves probe → activated and releases without going negative", () => {
    const budget = new SessionBudget();
    expect(budget.admit("9.9.9.9", 0).ok).toBe(true);
    budget.activate();
    expect(budget.snapshot()).toEqual({
      probeSessions: 0,
      activatedSessions: 1,
      rejectedNewSession: 0,
    });
    budget.releaseActivated();
    budget.releaseProbe();
    budget.releaseActivated();
    expect(budget.snapshot()).toEqual({
      probeSessions: 0,
      activatedSessions: 0,
      rejectedNewSession: 0,
    });
  });

  it("resets the IP window after ipWindowMs", () => {
    const budget = new SessionBudget(emptyBudgetState(), {
      ipLimit: 1,
      ipWindowMs: 1_000,
      globalProbeCap: 10,
    });
    expect(budget.admit("8.8.8.8", 0).ok).toBe(true);
    expect(budget.admit("8.8.8.8", 500).ok).toBe(false);
    expect(budget.admit("8.8.8.8", 1_000).ok).toBe(true);
    expect(budget.snapshot().probeSessions).toBe(2);
  });

  it("uses a stable ip bucket key", () => {
    expect(ipBucketKey("1.2.3.4")).toBe(ipBucketKey("1.2.3.4"));
    expect(ipBucketKey("1.2.3.4")).not.toBe(ipBucketKey("1.2.3.5"));
  });
});
