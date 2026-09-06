import { describe, expect, it } from "vitest";
import {
  GatewaySessionStore,
  scrubSensitiveFields,
  scrubSensitiveText,
  toolResultLeaksSecrets,
} from "../src/session.js";

describe("GatewaySessionStore", () => {
  it("holds token privately and returns public view without it", () => {
    const store = new GatewaySessionStore();
    store.set({
      sessionId: "sess_1",
      handle: "scout",
      agentId: "agt_1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      actions: ["look_around", "leave"],
      sessionToken: "hvs_secret_token_never_leak",
    });
    expect(store.hasSession()).toBe(true);
    expect(store.getToken()).toBe("hvs_secret_token_never_leak");
    const pub = store.getPublic();
    expect(pub).toEqual({
      sessionId: "sess_1",
      handle: "scout",
      agentId: "agt_1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      actions: ["look_around", "leave"],
    });
    expect(pub).not.toHaveProperty("sessionToken");
    expect(toolResultLeaksSecrets(pub)).toBe(false);
    store.clear();
    expect(store.hasSession()).toBe(false);
    expect(store.getToken()).toBeNull();
  });
});

describe("scrubSensitiveFields", () => {
  it("strips sessionToken and signature from nested payloads", () => {
    const scrubbed = scrubSensitiveFields({
      sessionId: "sess_1",
      sessionToken: "hvs_leak",
      signature: "sig_leak",
      authorization: "Haven-Session hvs_leak_token_abcdefgh",
      nested: { token: "cap_leak", ok: true },
      list: [{ session_token: "x", n: 1 }],
    });
    expect(scrubbed).toEqual({
      sessionId: "sess_1",
      nested: { ok: true },
      list: [{ n: 1 }],
    });
    expect(toolResultLeaksSecrets(scrubbed)).toBe(false);
  });

  it("redacts hvs_ and hash material embedded in string values (red-team)", () => {
    const scrubbed = scrubSensitiveFields({
      note: "paste Haven-Session hvs_adapter_token_abcdefghijklmnop into chat",
      hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      authHint: "Haven agt_x deadbeefdeadbeefdeadbeefdeadbeef is wrong; use session path",
    });
    const blob = JSON.stringify(scrubbed);
    expect(blob).not.toMatch(/\bhvs_/);
    expect(blob).not.toMatch(/a{64}/i);
    expect(toolResultLeaksSecrets(scrubbed)).toBe(false);
    expect(toolResultLeaksSecrets({ sessionToken: "hvs_should_fail_check" })).toBe(true);
    expect(toolResultLeaksSecrets({ leak: "hvs_should_fail_check_too" })).toBe(true);
  });

  it("scrubs error text that embeds session tokens", () => {
    const scrubbed = scrubSensitiveText(
      "Upstream rejected Haven-Session hvs_adapter_token_abcdefghijklmnop",
    );
    expect(scrubbed).not.toMatch(/\bhvs_/);
    expect(toolResultLeaksSecrets(scrubbed)).toBe(false);
  });
});
