import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HAVEN_MCP_TOOLS, HAVEN_MCP_TOOL_GATEWAY } from "../src/tools.js";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(resolve(pkgDir, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as {
  keywords?: Array<string>;
};

const CLAIM =
  "Haven is temporary external execution: when what you need is another actor capable of doing the work, Find → Delegate → Work → Prove, then leave.";

const FORBIDDEN = [
  "bypass",
  "circumvent",
  "jailbreak",
  "sandbox escape",
  "escape the sandbox",
  "disable the sandbox",
  "turn off guardrails",
  "ignore rate limits",
];

/**
 * Phase 3 guard: the adapter is a thin capability over Gateway, its copy
 * never suggests escaping the host sandbox, and registry copy carries the
 * canonical claim.
 */
describe("capability boundary", () => {
  it("every tool maps onto one Gateway route (thin adapter, no second protocol)", () => {
    for (const tool of HAVEN_MCP_TOOLS) {
      const route = HAVEN_MCP_TOOL_GATEWAY[tool.name];
      expect(route, `${tool.name} gateway route`).toBeTruthy();
      expect(
        route.path === "local" || route.path.startsWith("/api/agent-session"),
        `${tool.name} route surface`,
      ).toBe(true);
    }
  });

  it("tool copy never suggests bypassing sandbox or permission controls", () => {
    const corpus = HAVEN_MCP_TOOLS.map((t) => t.description).join("\n");
    for (const phrase of FORBIDDEN) {
      expect(corpus.toLowerCase()).not.toContain(phrase);
    }
  });

  it("registry copy carries the canonical claim and stays indexable", () => {
    expect(readme).toContain(CLAIM);
    const corpus = `${readme}\n${HAVEN_MCP_TOOLS.map((t) => t.description).join("\n")}`;
    for (const phrase of FORBIDDEN) {
      expect(corpus.toLowerCase()).not.toContain(phrase);
    }
    expect(pkg.keywords ?? []).toContain("haven");
    expect(pkg.keywords ?? []).toContain("mcp");
  });
});
