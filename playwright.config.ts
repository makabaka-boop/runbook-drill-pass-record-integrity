import { defineConfig } from '@playwright/test';

// 默认对接 `npm run preview`（4173）；Docker verify 服务通过 BASE_URL 指向 web 容器。
const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const useWebServer = !process.env.PW_NO_WEB_SERVER;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputDir: 'playwright-report' }]],
  timeout: 60_000,
  use: {
    baseURL,
    actionTimeout: 15_000,
    headless: true,
    launchOptions: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Docker Compose 内通过 http://web 这种非安全上下文注册 SW / 使用 crypto.subtle
        '--unsafely-treat-insecure-origin-as-secure=http://web,http://web:80,http://web:8080,http://web:3000,http://localhost,http://localhost:4173',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: useWebServer
    ? {
        command: 'npm run preview',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: true,
        timeout: 60_000,
      }
    : undefined,
});
