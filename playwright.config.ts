import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 4877)
const PREVIEW = process.env.E2E_PREVIEW === '1'
const baseURL = `http://127.0.0.1:${PREVIEW ? 4878 : PORT}`

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    hasTouch: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /sr\.spec\.ts/,
    },
    {
      // Super resolution needs WebGPU: the headless shell has none, the full browser in
      // "new headless" mode exposes the real GPU (or none on CI, where the fallback path is tested).
      name: 'webgpu',
      testMatch: /sr\.spec\.ts/,
      use: {
        launchOptions: {
          headless: false,
          args: ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
        },
      },
    },
  ],
  webServer: {
    command: PREVIEW ? 'npm run preview' : 'npm run dev',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
