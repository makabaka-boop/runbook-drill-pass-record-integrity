import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { serviceWorkerBuild } from './plugins/sw-build';

// 纯前端应用：无后端、无在线服务。SW 由插件在构建期编译并注入预缓存清单。
export default defineConfig({
  plugins: [react(), serviceWorkerBuild()],
  build: {
    target: 'es2020',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
