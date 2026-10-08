import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Standalone Vitest config (does not load vite-plugin-pwa). The React plugin is loaded
// so component/orchestration tests (.test.tsx) transform JSX; the default environment
// stays Node for the pure-logic property tests, while component tests opt into jsdom
// per-file via a `// @vitest-environment jsdom` docblock. The `@` alias mirrors
// vite.config.ts.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
