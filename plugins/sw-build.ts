import type { Plugin, ResolvedConfig } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build as esbuildBuild } from 'esbuild';

const SW_ID = 'src/service-worker/service-worker.ts';
const SW_URL = '/service-worker.js';

/**
 * 构建期 Service Worker 插件：
 * - 用 esbuild 把 src/service-worker/service-worker.ts 编译为单个 /service-worker.js
 * - 生产构建时，将所有同源构建产物（JS/CSS/HTML）写入预缓存清单，
 *   注入 SW 的 SW_PRECACHE 定义；手册资源不进入预缓存，仅由安装流程写入代际缓存
 * - 开发时以中间件即时编译 SW（空预缓存，SW 走网络优先以便 HMR）
 */
export function serviceWorkerBuild(): Plugin {
  let config: ResolvedConfig;

  const compileSw = async (entries: { url: string; revision: string }[], version: string) => {
    // 测试故障注入补丁：无规则时完全透传，生产行为不变。
    const { faultPatchSource } = await import('../src/test/fault-injection');
    const result = await esbuildBuild({
      entryPoints: [SW_ID],
      entryNames: '[name]',
      bundle: true,
      format: 'iife',
      target: ['chrome105'],
      write: false,
      sourcemap: false,
      legalComments: 'none',
      absWorkingDir: process.cwd(),
      banner: { js: faultPatchSource },
      define: {
        SW_VERSION: JSON.stringify(version),
        SW_PRECACHE: JSON.stringify(entries),
      },
    });
    return result.outputFiles[0].text;
  };

  const walkAssets = (outDir: string) => {
    const root = path.resolve(outDir);
    const out: { url: string; content: Buffer }[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else {
          const rel = path.relative(root, full).split(path.sep).join('/');
          out.push({ url: `/${rel}`, content: fs.readFileSync(full) });
        }
      }
    };
    walk(root);
    return out;
  };

  return {
    name: 'service-worker-build',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (url !== SW_URL) {
          next();
          return;
        }
        try {
          const code = await compileSw([], `dev-${Date.now()}`);
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.end(code);
        } catch (err) {
          config.logger.error(`SW 编译失败: ${String(err)}`);
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
    async closeBundle() {
      if (config.command !== 'build') {
        return;
      }
      // closeBundle 阶段 Rollup 产物已落盘，递归扫描 dist 生成预缓存清单。
      const entries = walkAssets(config.build.outDir)
        .filter((f) => f.url !== SW_URL)
        // 手册资源绝不进入应用壳预缓存：只能经“下载 + SHA-256 校验”进入代际缓存。
        .filter((f) => !f.url.startsWith('/manuals/'))
        .map((f) => ({
          url: f.url,
          revision: createHash('sha256').update(f.content).digest('hex').slice(0, 16),
        }));
      const code = await compileSw(entries, `sw-${Date.now()}`);
      fs.writeFileSync(path.resolve(config.build.outDir, 'service-worker.js'), code, 'utf8');
    },
  };
}
