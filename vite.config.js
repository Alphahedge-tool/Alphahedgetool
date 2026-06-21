import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      "/api": "http://localhost:5174"
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("highcharts")) return "highcharts";
          if (id.includes("uplot")) return "uplot";
          if (id.includes("@kobalte")) return "kobalte";
          if (id.includes("solid-js")) return "solid";
          if (id.includes("plotly")) return "plotly";
        }
      }
    }
  }
});
