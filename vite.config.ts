import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Project-site Pages are served from /<repo>/, so production assets must be
  // prefixed accordingly. Dev keeps the root base.
  base: command === "build" ? "/Made-With-ML/" : "/",
  server: {
    host: true,
    port: 5173,
  },
}));
