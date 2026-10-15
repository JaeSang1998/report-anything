import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import { createChatHandler, modelChoice, resolveModel } from "./server/chat.js";

const repo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** Serves the agent endpoints from the dev server, so the playground is one process. */
function reportAgent(env: Record<string, string>): Plugin {
  const handler = createChatHandler({ model: () => resolveModel(env), skillDir: repo("skills/report-anything") });
  return {
    name: "report-agent",
    configureServer(server) {
      // Which agent the browser should use: a hosted model, or null → the keyless local agent.
      server.middlewares.use("/api/agent", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(modelChoice(env)));
      });
      server.middlewares.use("/api/chat", (req, res) => {
        handler(req, res).catch((err: unknown) => {
          server.config.logger.error(String(err));
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(err instanceof Error ? err.message : String(err));
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the static build under /<repo>/; the workflow sets PLAYGROUND_BASE.
  base: process.env.PLAYGROUND_BASE ?? "/",
  plugins: [react(), reportAgent(loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), ""))],
  // Design working files (decision mocks, surface briefs) are never served.
  server: { fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.impeccable/**"] } },
  resolve: {
    alias: {
      "@report-anything/core": repo("packages/core/src/index.ts"),
      "@report-anything/react/styles.css": repo("packages/react/src/styles.css"),
      "@report-anything/react": repo("packages/react/src/index.ts"),
    },
  },
}));
