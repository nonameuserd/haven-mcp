import { HAVEN_MCP_SERVER_VERSION } from "../src/tools.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The official MCP Registry manifest (`server.json`).
 *
 * The registry is the one machine-readable discovery surface an MCP host or an
 * aggregator queries, so a manifest that quietly stops validating is a door
 * that silently closes. These are the constraints the schema itself enforces,
 * pinned here because a publish is a remote action and a failure there is
 * discovered by nobody: `description` is capped at 100 characters, the name is
 * reverse-DNS with exactly one slash, and the version carries no range.
 */

type ServerJson = {
  $schema?: string;
  name: string;
  title?: string;
  description: string;
  websiteUrl?: string;
  version: string;
  repository?: { url: string; source?: string };
  packages?: Array<{
    registryType: string;
    identifier: string;
    version?: string;
    transport: { type: string };
  }>;
  remotes?: Array<{ type: string; url: string }>;
};

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(resolve(pkgDir, "server.json"), "utf8"),
) as ServerJson;
const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as {
  name: string;
  version: string;
};

const LIVE_MCP_URL = "https://haven-mcp.chitmark.workers.dev/mcp";
const LIVE_SITE_URL = "https://haven.chitmark.com";

/** Registry schema 2025-12-11, `ServerDetail.name`. */
const NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

describe("server.json (official MCP Registry manifest)", () => {
  it("advertises the exact package version at runtime and in both registry fields", () => {
    expect(HAVEN_MCP_SERVER_VERSION).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.packages?.[0]?.version).toBe(pkg.version);
  });
  it("names the server in reverse-DNS with the GitHub owner as namespace", () => {
    expect(manifest.name).toMatch(NAME_PATTERN);
    // One slash, so the namespace is `io.github.<owner>` and not something a
    // namespace claim cannot be made against.
    expect(manifest.name.split("/")).toHaveLength(2);
    expect(manifest.name).toBe("io.github.nonameuserd/haven-mcp");
  });

  it("describes the wedge inside the schema's 100 character cap", () => {
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.description.length).toBeLessThanOrEqual(100);
    // The description is the only copy an aggregator shows verbatim, so it has
    // to say what Haven is for rather than that it exists.
    expect(manifest.description.toLowerCase()).toContain("delegate");
  });

  it("carries a version with no range, matching the published package", () => {
    expect(manifest.version).not.toMatch(/[\^~><]|\bx\b|\*/);
    expect(manifest.version).toBe(pkg.version);
  });

  it("points at the npm package and the remote Worker, so both doors install", () => {
    const npm = (manifest.packages ?? []).find(
      (p) => p.registryType === "npm" && p.identifier === "@chitmark/haven-mcp",
    );
    expect(npm, "stdio package entry").toBeTruthy();
    expect(npm!.transport.type).toBe("stdio");
    expect(npm!.version).toBe(pkg.version);
    const remote = (manifest.remotes ?? []).find((r) => r.url === LIVE_MCP_URL);
    expect(remote, "remote streamable-http entry").toBeTruthy();
    expect(remote!.type).toBe("streamable-http");
  });

  it("points its repository at the public mirror so the namespace can be verified", () => {
    expect(manifest.repository?.url).toBe("https://github.com/nonameuserd/haven-mcp");
    expect(manifest.repository?.source).toBe("github");
  });

  it("keeps websiteUrl plain, because that field renders in someone else's UI", () => {
    expect(manifest.websiteUrl).toBe(LIVE_SITE_URL);
    // The registry catalogue had a stored-XSS advisory through a
    // publisher-controlled `websiteUrl` breaking out of an attribute, so the
    // value is pinned as a bare https URL with no quote, angle bracket, or
    // query string in it.
    expect(manifest.websiteUrl).not.toMatch(/["'<>?]/);
  });

  it("ships the manifest in the tarball, or the registry has nothing to read", () => {
    const files = (
      JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as {
        files?: Array<string>;
      }
    ).files;
    expect(files ?? []).toContain("server.json");
  });
});
