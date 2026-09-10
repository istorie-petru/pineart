import { defineConfig } from "vite";

// Vite's DNS-rebinding protection rejects any Host header it doesn't
// recognize by default -- localhost and bare IPs are allowed automatically,
// a real public hostname is not. artboard-ctl's systemd units pass this
// through as an EnvironmentFile entry (see write_env_template in
// backend/deploy/artboard-ctl) so a deploy sitting behind a real reverse
// proxy or a Cloudflare Tunnel can allow its own hostname without editing
// this file. Comma-separated; empty/unset means "no additional hosts",
// which is exactly the local-dev/health-check case (127.0.0.1 is already
// allowed either way).
const additionalAllowedHosts = (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  server: {
    port: 5173,
    allowedHosts: additionalAllowedHosts.length > 0 ? additionalAllowedHosts : undefined,
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
    allowedHosts: additionalAllowedHosts.length > 0 ? additionalAllowedHosts : undefined,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
