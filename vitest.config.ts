import { defineConfig } from "vitest/config";
import path from "node:path";

// Standalone Vitest config (does not load vite-plugin-pwa). Node environment is fine
// for the pure-logic property tests; the `@` alias mirrors vite.config.ts.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
