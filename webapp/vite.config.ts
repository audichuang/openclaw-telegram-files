import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  base: "/plugins/telegram-files/",
  build: {
    outDir: resolve(__dirname, "..", "dist", "webapp"),
    emptyOutDir: true,
    target: "es2020",
  },
  server: {
    port: 5173,
  },
});
