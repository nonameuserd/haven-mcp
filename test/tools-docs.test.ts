import { describe, expect, it } from "vitest";
import { buildHavenMcpToolList } from "../src/server.js";
import { HAVEN_MCP_TOOLS } from "../src/tools.js";

/**
 * Tool documentation quality (Glama TDQS dimensions):
 * behavioral disclosure, first-attempt success, parameter intent,
 * and machine-readable annotations. No silent undocumented tools.
 */
describe("tool documentation", () => {
  it("every tool carries behavioral disclosure and annotations", () => {
    for (const t of HAVEN_MCP_TOOLS) {
      expect(t.description.length, `${t.name} description`).toBeGreaterThanOrEqual(80);
      expect(t.annotations, `${t.name} annotations`).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint, `${t.name} readOnlyHint`).toBe(
        "boolean",
      );
    }
  });

  it("every schema property explains itself", () => {
    for (const t of HAVEN_MCP_TOOLS) {
      for (const [key, prop] of Object.entries(t.inputSchema.properties)) {
        const desc = (prop as { description?: unknown }).description;
        expect(typeof desc, `${t.name}.${key} description`).toBe("string");
        expect(
          (desc as string).length,
          `${t.name}.${key} description length`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("types the nested roster filter instead of leaving an empty object", () => {
    const find = HAVEN_MCP_TOOLS.find((t) => t.name === "find_agent");
    const filter = find?.inputSchema.properties.filter as {
      type?: string;
      properties?: Record<string, { description?: unknown }>;
    };
    expect(filter?.type).toBe("object");
    for (const key of ["attestedOnly", "activity", "handlePrefix", "city", "limit"]) {
      expect(typeof filter?.properties?.[key]?.description, `filter.${key}`).toBe(
        "string",
      );
    }
  });

  it("marks pure reads read-only and session revocation destructive", () => {
    const byName = Object.fromEntries(HAVEN_MCP_TOOLS.map((t) => [t.name, t]));
    expect(byName.look_around.annotations?.readOnlyHint).toBe(true);
    expect(byName.session_status.annotations?.readOnlyHint).toBe(true);
    expect(byName.find_agent.annotations?.readOnlyHint).toBe(false);
    expect(byName.handoff.annotations?.readOnlyHint).toBe(false);
    expect(byName.leave.annotations?.destructiveHint).toBe(true);
    expect(byName.leave.annotations?.idempotentHint).toBe(true);
  });

  it("serves annotations through the ListTools mapping", () => {
    const listed = buildHavenMcpToolList();
    expect(listed.map((t) => t.name)).toEqual(HAVEN_MCP_TOOLS.map((t) => t.name));
    const look = listed.find((t) => t.name === "look_around");
    expect(look?.annotations?.readOnlyHint).toBe(true);
    const leave = listed.find((t) => t.name === "leave");
    expect(leave?.annotations?.destructiveHint).toBe(true);
    const wake = listed.find((t) => t.name === "wake");
    expect(wake?.annotations?.readOnlyHint).toBe(false);
  });
});
