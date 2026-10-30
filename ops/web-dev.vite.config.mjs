// Local-only Vite config to view the merchant dashboard inside Docker.
// إعداد محلي بس، عشان نشوف لوحة التاجر من داخل Docker.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0", // reachable from outside the container / عشان نقدر نفتحه من برا الحاوية
    port: 5173,
    proxy: {
      "/v1": "http://api:3000", // forward API calls to the api / يحوّل طلبات الـ API
    },
  },
});