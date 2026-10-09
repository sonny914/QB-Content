import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  outputDir: 'test-results',
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'npx vite build && node scripts/dev.mjs preview',
    // Playwright's Chromium cannot decode H.264/AAC, so the tests render to VP9/Opus WebM instead.
    env: { QB_RENDER_FORMAT: 'webm' },
    url: 'http://localhost:4173',
    reuseExistingServer: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
})
