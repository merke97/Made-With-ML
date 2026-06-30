// Standalone proxy server. Run with: npm run server  (or: node server/index.mjs)
// Exposes /api/* (spec §11) and adds permissive CORS so it can be deployed
// separately from the static front-end if you ever host the live demo.

import { createServer } from "node:http";
import { handleApi } from "./handlers.mjs";

const PORT = Number(process.env.PORT) || 8080;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (!url.pathname.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }

  const { status, body } = await handleApi(url.pathname.slice(4), url.searchParams);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
});

server.listen(PORT, () => {
  console.log(`DR-arkivet proxy on http://localhost:${PORT}  (upstream: ${process.env.KB_BASE || "kb.dk"})`);
});
