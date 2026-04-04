import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES === "true" ? "/sentri/" : "/",
  server: {
    port: 3000,
    proxy: {
      // SSE endpoints are long-lived streams — disable proxy timeouts so
      // http-proxy doesn't kill them after 60 s, causing ECONNRESET on the
      // frontend and a reconnect loop in useRunSSE.
      // Scoped to /events suffix so non-SSE run endpoints (GET /api/runs/:id,
      // POST /api/runs/:id/abort) still use the normal 60 s timeout from /api.
      "/api/runs/": {
        target: "http://localhost:3001",
        changeOrigin: true,
        timeout: 60000,
        proxyTimeout: 60000,
        configure: (proxy) => {
          // Disable timeouts only for SSE event streams
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.url?.includes("/events")) {
              proxyReq.socket?.setTimeout(0);
              // Also set the response socket timeout when available
              req.res?.setTimeout(0);
            }
          });
          proxy.on("error", (err, _req, res) => {
            console.warn("[proxy /api/runs error]", err.message);
            if (!res.headersSent) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Server busy, please retry shortly" }));
            }
          });
        },
      },
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        timeout: 60000,
        proxyTimeout: 60000,
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            console.warn("[proxy /api error]", err.message);
            if (!res.headersSent) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Server busy, please retry shortly" }));
            }
          });
          proxy.on("proxyReq", (_proxyReq, req) => {
            console.debug(`[proxy] ${req.method} ${req.url}`);
          });
        },
      },
      "/artifacts": {
        target: "http://localhost:3001",
        changeOrigin: true,
        timeout: 60000,
        proxyTimeout: 60000,
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            console.warn("[proxy /artifacts error]", err.message);
            if (!res.headersSent) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Server busy, please retry shortly" }));
            }
          });
        },
      },
    },
  },
});