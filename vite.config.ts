import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Mounts the DR-arkivet proxy at /api/* during `npm run dev`, so the front-end
// gets real data with no separate process and no CORS. The same handler runs
// standalone via `npm run server` for deployment. Set KB_BASE to point at the
// mock during offline verification.
function drProxy(): Plugin {
  return {
    name: "dr-archive-proxy",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res) => {
        const { handleApi } = await import("./server/handlers.mjs");
        const url = new URL(req.url ?? "/", "http://localhost");
        const { status, body } = await handleApi(url.pathname, url.searchParams);
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), drProxy()],
  // Project-site Pages are served from /<repo>/, so production assets must be
  // prefixed accordingly. Dev keeps the root base.
  base: command === "build" ? "/Made-With-ML/" : "/",
  server: {
    host: true,
    port: 5173,
  },
}));
