import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;
// The Python server (audio capture, sync, media control) listens here; Vite proxies to it in dev.
const backend = `http://127.0.0.1:${process.env.PHONEBOXSOUND_PORT || 8080}`;

/** Same URLs in dev as in production: /control and /player. */
const prettyRoutes = (): Plugin => ({
  name: "pbs-pretty-routes",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const [path, query = ""] = (req.url || "").split("?");
      if (path === "/control" || /^\/(dashboard|nowplaying|devices|remote|intercom|presets|activity|settings)$/.test(path)) req.url = "/control.html" + (query ? "?" + query : "");
      else if (path === "/player") req.url = "/index.html" + (query ? "?" + query : "");
      next();
    });
  },
});

export default defineConfig({
  root: "web",
  plugins: [react(), prettyRoutes()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
    manifest: true, // the server reads it to keep dashboard files away from phones
    cssCodeSplit: true,
    rollupOptions: {
      input: { player: resolve(root, "web/index.html"), control: resolve(root, "web/control.html") },
      // React changes rarely: its own chunk stays cached across app updates.
      output: { manualChunks: (id) => (/node_modules[\/](react|react-dom|scheduler)[\/]/.test(id) ? "react" : undefined) },
    },
  },
  server: {
    host: true, // phones on the LAN can open the dev server too
    port: 5173,
    open: "/dashboard",
    proxy: {
      "/ws": { target: backend, ws: true, xfwd: true },
      "/api": { target: backend, xfwd: true },
      "/art": { target: backend, xfwd: true },
      "/qr.svg": { target: backend, xfwd: true },
    },
  },
});
