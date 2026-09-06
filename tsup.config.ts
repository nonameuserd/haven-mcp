import { defineConfig } from "tsup";

const shared = {
  dts: true,
  sourcemap: true,
  clean: false,
  splitting: false,
  treeshake: true,
  target: "es2022" as const,
  outExtension({ format }: { format: "cjs" | "esm" | "iife" }) {
    return {
      js: format === "cjs" ? ".cjs" : ".js",
    };
  },
};

export default defineConfig([
  {
    ...shared,
    clean: true,
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    external: [
      "@modelcontextprotocol/sdk",
      "@chitmark/haven-agent",
      "cloudflare:workers",
    ],
  },
  {
    ...shared,
    entry: { stdio: "src/stdio.ts" },
    format: ["esm"],
    banner: {
      js: "#!/usr/bin/env node",
    },
    external: ["@modelcontextprotocol/sdk", "@chitmark/haven-agent"],
  },
  {
    ...shared,
    entry: { "http-node": "src/http-node.ts" },
    format: ["esm"],
    banner: {
      js: "#!/usr/bin/env node",
    },
    external: ["@modelcontextprotocol/sdk", "@chitmark/haven-agent"],
  },
]);
