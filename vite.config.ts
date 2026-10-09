import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The render service (server/index.mjs) listens on 127.0.0.1:5174. Proxying /api keeps the
// browser on one origin, so the page and the uploads both stay on localhost.
const api = { '/api': { target: 'http://127.0.0.1:5174', changeOrigin: false } }

export default defineConfig({
  plugins: [react()],
  server: { proxy: api },
  preview: { proxy: api },
  test: {
    include: ['src/**/*.test.ts', 'server/**/*.test.mjs'],
    testTimeout: 60_000,
  },
})
