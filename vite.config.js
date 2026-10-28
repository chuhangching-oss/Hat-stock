import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 每次部署新版後自動更新 Service Worker 並 Reload
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        lang: 'zh-Hant',
        name: '針織帽廠庫存管家',
        short_name: '庫存管家',
        description: '小型針織/成帽工廠專用：雲端庫存查詢與出入庫快速填報系統',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#1d4ed8',
        background_color: '#0f172a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 只 precache 前端外殼檔案；API 一律走網路以確保庫存即時
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: 'index.html',
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            // 明確「不快取」Google API 回應，避免看到舊庫存
            urlPattern: ({ url }) =>
              url.hostname.includes('script.google.com') ||
              url.hostname.includes('googleusercontent.com'),
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    host: true, // 讓手機可用區網 IP 開啟 dev 預覽
  },
  build: {
    sourcemap: false,
  },
});
