import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { HavenGatewayBridge, type HavenGatewayBridgeOptions } from "./gateway.js";
import { scrubSensitiveText, toolResultLeaksSecrets } from "./session.js";
import {
  HAVEN_MCP_SERVER_NAME,
  HAVEN_MCP_SERVER_VERSION,
  HAVEN_MCP_TOOLS,
  type HavenMcpToolName,
} from "./tools.js";

const TOOL_NAMES = new Set<string>(HAVEN_MCP_TOOLS.map((t) => t.name));

export type CreateHavenMcpServerOptions = HavenGatewayBridgeOptions & {
  /** Reuse an existing bridge (HTTP session slots / Durable Objects). */
  bridge?: HavenGatewayBridge;
};

/**
 * Build an MCP Server that adapts tools onto Haven Gateway.
 * Wire a transport (stdio or Streamable HTTP) separately.
 */
export const createHavenMcpServer = (
  opts: CreateHavenMcpServerOptions = {},
): { server: Server; bridge: HavenGatewayBridge } => {
  const bridge = opts.bridge ?? new HavenGatewayBridge(opts);
  const server = new Server(
    { name: HAVEN_MCP_SERVER_NAME, version: HAVEN_MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: HAVEN_MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!TOOL_NAMES.has(name)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      };
    }
    const args =
      request.params.arguments && typeof request.params.arguments === "object"
        ? (request.params.arguments as Record<string, unknown>)
        : {};
    const result = await bridge.call(name as HavenMcpToolName, args);
    const payload = result.ok ? result.content : { error: result.error };
    // Defense in depth: scrub again at the MCP content boundary.
    let text = scrubSensitiveText(JSON.stringify(payload, null, 2));
    if (toolResultLeaksSecrets(text)) {
      text = JSON.stringify(
        {
          error:
            "Tool result blocked: sensitive session or attestation material was detected and withheld.",
        },
        null,
        2,
      );
    }
    return {
      isError: !result.ok,
      content: [{ type: "text" as const, text }],
    };
  });

  return { server, bridge };
};
