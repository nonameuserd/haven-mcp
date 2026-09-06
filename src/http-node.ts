import { createServer } from "node:http";
import { createHavenMcpHttpHandler } from "./http.js";

/**
 * Local Streamable HTTP MCP entry for remote-style hosts and integration tests.
 *
 * Env:
 * - HAVEN_BASE_URL — Gateway origin (default https://haven.chitmark.com)
 * - PORT — listen port (default 8789)
 * - HOST — bind address (default 127.0.0.1)
 *
 * Connection URL: `http://127.0.0.1:8789/mcp`
 *
 * Unlike stdio, this keeps MCP protocol sessions in process memory. Production
 * remote MCP uses the Cloudflare Worker + Durable Object under `worker/`.
 */
async function main(): Promise<void> {
  const baseUrl = process.env.HAVEN_BASE_URL?.trim() || undefined;
  const port = Number(process.env.PORT ?? "8789");
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const handler = createHavenMcpHttpHandler({ baseUrl });

  const server = createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host ?? `${host}:${port}`;
      const url = new URL(req.url ?? "/", `http://${hostHeader}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const body =
        req.method === "GET" || req.method === "HEAD" || req.method === "DELETE"
          ? undefined
          : Buffer.concat(chunks);
      const request = new Request(url, {
        method: req.method,
        headers,
        body: body && body.length > 0 ? body : undefined,
      });
      const response = await handler.fetch(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(port, host, () => {
    console.error(`haven-mcp streamable-http listening on http://${host}:${port}/mcp`);
    console.error(`HAVEN_BASE_URL=${baseUrl ?? "https://haven.chitmark.com"}`);
  });

  const shutdown = async (): Promise<void> => {
    await handler.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`haven-mcp http failed: ${message}`);
  process.exit(1);
});
