// Admin console dev server for the compose stack (same idea as web-dev.vite.config.mjs).
// سيرفر لوحة الإدارة داخل docker compose (نفس فكرة web-dev.vite.config.mjs).
// Listens on all interfaces so it works on the server's IP, and proxies /v1 to
// the api container, so the browser talks to one origin (no CORS, cookies work).
// يسمع على كل العناوين عشان يشتغل على IP السيرفر، ويحوّل /v1 للـ api،
// فالمتصفح يكلم عنوان واحد (بدون مشاكل CORS، والكوكيز تشتغل).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5174,
    strictPort: true,
    proxy: { "/v1": "http://api:3000" },
  },
});