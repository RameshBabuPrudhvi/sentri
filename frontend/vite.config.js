import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function cspNoncePlugin() {
  return {
    name: "sentri-csp-nonce",
    transformIndexHtml(html) {
      return html.replace(/<script(?![^>]*\bnonce=)/g, '<script nonce="__CSP_NONCE__"');
    },
  };
}

export default defineConfig({
  plugins: [react(), cspNoncePlugin()],
  base: process.env.GITHUB_PAGES === "true" ? "/sentri/" : "/",

  build: {
    rollupOptions: {
      output: {
        // Split large vendor libraries into separate cacheable chunks so that
        // app code changes don't bust the vendor cache (and vice versa).
        manualChunks: {
          // React ecosystem — changes infrequently
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          // Charting library — large and self-contained
          "vendor-recharts": ["recharts"],
          // Icon library — large tree before shaking
          "vendor-icons": ["lucide-react"],
        },
      },
    },
    // Emit a warning when any single chunk exceeds 600 kB (Vite default is 500 kB)
    chunkSizeWarningLimit: 600,
  },

  server: {
    port: 3000,
    proxy: {
      // SSE endpoints are long-lived streams — disable proxy timeouts so
      // http-proxy doesn't kill them after 60 s, causing ECONNRESET on the
      // frontend and a reconnect loop in useRunSSE.
      // INF-005: Frontend now sends requests to /api/v1/runs/
      "/api/v1/runs/": {
        target: "http://localhost:3001",
        changeOrigin: true,
        timeout: 60000,
        proxyTimeout: 60000,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.url?.includes("/events")) {
              proxyReq.socket?.setTimeout(0);
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
