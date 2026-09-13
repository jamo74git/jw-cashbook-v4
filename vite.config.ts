import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// Per-asset-class caching blueprint (from design.md "Caching strategy per asset class"):
// - App shell (index.html) + JS/CSS chunks + fonts + icons -> PRECACHE (globPatterns)
// - Local static images / logo                             -> CacheFirst (with expiration)
// - Supabase REST / Auth / Edge Function calls             -> NetworkOnly (never cached)
// - Reference lookups (congregations, hierarchy)           -> persisted to Dexie, not SW cache
// - Capture data                                           -> served from Dexie, not the SW
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt' so an in-progress capture is never interrupted by a silent SW swap.
      registerType: "prompt",
      injectRegister: "auto",
      includeAssets: ["nac-logo.png"],
      manifest: {
        name: "OAC Cashbook",
        short_name: "OAC Cashbook",
        description: "OAC Cashbook — offline-first field capture and Head Office review",
        theme_color: "#0f172a",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "nac-logo.png", sizes: "192x192", type: "image/png" },
          { src: "nac-logo.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // Precache the app shell + all build chunks so Capture loads fully offline.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        // SPA fallback so client-side routes resolve offline.
        navigateFallback: "index.html",
        // Do NOT let the SW hijack Supabase Edge Function / auth POSTs.
        navigateFallbackDenylist: [/^\/api/, /supabase\.co/],
        runtimeCaching: [
          {
            // All Supabase traffic (REST, Auth, Storage, Edge Functions) is online-only.
            // Admin data must never be served stale from cache (Req 2.4, 2.5).
            urlPattern: ({ url }) => url.hostname.endsWith("supabase.co"),
            handler: "NetworkOnly",
            method: "GET",
          },
          {
            // Local static images / logo — safe to serve from cache.
            urlPattern: ({ request }) => request.destination === "image",
            handler: "CacheFirst",
            options: {
              cacheName: "static-images",
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Accept both Vite-native and legacy Next.js public env prefixes so the existing
  // .env.local (NEXT_PUBLIC_*) keeps working without edits during the migration.
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        // Isolate heavy vendor deps into their own chunks so the initial PWA shell
        // download stays lightweight and these cache independently across releases.
        manualChunks: {
          supabase: ["@supabase/supabase-js"],
          dexie: ["dexie"],
          router: ["react-router-dom"],
        },
      },
    },
  },
});
