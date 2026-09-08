import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:18787', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1100 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'node --import tsx tools/test-server.ts',
    url: 'http://127.0.0.1:18787/api/setup',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
