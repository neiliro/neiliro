import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/*
  What the About block and the sidebar show. The version is the product's
  own (the root manifest, bumped with the release tag); BUILD_SHA arrives
  as a Docker build argument, because .git never enters the image.

  Running from source leaves the commit empty and only the version shows —
  a dev build has no commit worth quoting.
*/
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const BUILD_SHA = (process.env.BUILD_SHA ?? '').slice(0, 7);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
  },
  plugins: [
    react(),
    tailwindcss(),
    /*
      PWA (#9): installable app + offline reading + update detection.
      Everything stays self-hosted at runtime (the strict CSP allows no
      external scripts); the plugin is build-time only. Registration is
      manual (web/src/lib/pwa.ts) — the app skips it in demo mode, and
      the "prompt" mode drives the "hub was updated" toast instead of
      silently activating a new worker under a running session.
    */
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Neiliro',
        short_name: 'Neiliro',
        description: 'Tasks, notes, calendar and money for a household',
        start_url: '/',
        display: 'standalone',
        background_color: '#f6f7f4',
        theme_color: '#f6f7f4',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The SPA shell answers offline navigations; the API never does
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Attachments are immutable by id — cache-first, capped
            urlPattern: /\/api\/attachments\/[0-9a-f-]+/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'attachments',
              expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // The one auth read that must survive offline: without a
            // cached session answer an offline reload lands on the
            // sign-in screen and the cached data below is unreachable.
            // NetworkFirst keeps it honest online; logout clears the
            // cache (see logout() in lib/auth.tsx).
            urlPattern: /\/api\/auth\/me$/,
            method: 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'session',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 1 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Offline READ of hub data: fresh when online, the last
            // snapshot when not. The rest of auth stays uncached.
            urlPattern: /\/api\/(?!auth\/)/,
            method: 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-reads',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: true, // доступ с планшета и телефона по локальной сети
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { outDir: 'dist', sourcemap: true },
});
