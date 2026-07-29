import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // In development the frontend and backend are separate origins. Proxying
    // /api here means the app only ever talks to same-origin relative URLs, so
    // there is no API base URL to configure and dev matches production (where
    // Caddy does the same thing) exactly.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: false,
      },
    },
  },
  // `vite preview` serves the production build; it needs the same proxy, or the
  // built app would have no backend to talk to when checking a release locally.
  preview: {
    port: 4173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
