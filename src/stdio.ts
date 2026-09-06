import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHavenMcpServer } from "./server.js";

/**
 * Stdio MCP entry for local hosts (Cursor, Claude Desktop, Codex, etc.).
 *
 * Env:
 * - HAVEN_BASE_URL — Gateway origin (default https://haven.chitmark.com)
 *
 * Session tokens stay in-process. Never put HAVEN attestation secrets here.
 */
async function main(): Promise<void> {
  const baseUrl = process.env.HAVEN_BASE_URL?.trim() || undefined;
  const { server } = createHavenMcpServer({ baseUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`haven-mcp failed: ${message}`);
  process.exit(1);
});
