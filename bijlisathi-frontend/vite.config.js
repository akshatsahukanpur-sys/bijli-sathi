import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import viteCompression from 'vite-plugin-compression'

export default defineConfig({
  plugins: [
    react(),
    // PWA — makes BijliSathi installable (PRD Phase 3: PWA wrapper)
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo.png', 'vite.svg'],
      manifest: {
        name: 'BijliSathi — Kanpur Power Grid',
        short_name: 'BijliSathi',
        description: 'Report power cuts in 30 seconds, track your technician live.',
        theme_color: '#0A1B33',
        background_color: '#F7F5F0',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          { src: 'logo.png', sizes: '192x192', type: 'image/png' },
          { src: 'logo.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts-cache', expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
      },
    }),
    // Gzip + Brotli compression for faster loads on low-end devices / patchy networks
    viteCompression({ algorithm: 'gzip', ext: '.gz' }),
    viteCompression({ algorithm: 'brotliCompress', ext: '.br' }),
  ],
  server: {
    host: true,
    port: 5173,
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'leaflet', 'react-hot-toast', '@tanstack/react-query', 'zustand'],
    exclude: [],
  },
  build: {
    // Better chunking — precise regex so react-* libs don't all jam into vendor (was causing race && lag)
    chunkSizeWarningLimit: 900,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // Only exact react / react-dom -> vendor (not react-hot-toast, etc)
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/scheduler/')) return 'vendor'
          if (id.includes('node_modules/react-router-dom')) return 'router'
          if (id.includes('node_modules/leaflet') || id.includes('node_modules/react-leaflet')) return 'maps'
          if (id.includes('node_modules/recharts')) return 'charts'
          if (id.includes('node_modules/framer-motion')) return 'motion'
          // Everything else in node_modules -> deps, but react-* stays out of vendor to avoid chunk race
          if (id.includes('node_modules')) return 'deps'
        },
      },
    },
    // Reduce initial payload on 50KB/s (seen in screenshot): target modern browsers only
    target: 'esnext',
  },
})
