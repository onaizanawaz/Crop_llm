import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Loaded with an empty prefix so GROQ_API_KEY is readable here without the
  // VITE_ prefix that would bundle it into the browser build.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Proxying keeps the browser on one origin, so CORS and preflight never
      // enter the picture in dev. Override with VITE_API_BASE for a deployed API.
      proxy: {
        "/api": {
          target: "http://localhost:8000",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ""),
        },
        // The assistant's model: the same Groq account the backend planner uses.
        // Same reason as /api -- the browser stays on one origin.
        //
        // The key is attached HERE, by the dev server, and never reaches the
        // browser: a VITE_-prefixed variable would be inlined into the bundle
        // and readable by anyone who opens the page. Point VITE_LLM_BASE at
        // /groq/v1.
        "/groq": {
          target: "https://api.groq.com",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/groq/, "/openai"),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (env.GROQ_API_KEY) {
                proxyReq.setHeader("Authorization", `Bearer ${env.GROQ_API_KEY}`);
              }
            });
          },
          // Groq answers in seconds, but a long tool-using prompt plus a 429
          // retry can still run long. Generous, not unbounded.
          timeout: 120_000,
          proxyTimeout: 120_000,
        },
      },
    },
  };
});