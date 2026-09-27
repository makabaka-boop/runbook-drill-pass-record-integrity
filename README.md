# 地下机房断电 · 离线作业手册

纯前端（TypeScript + React + Vite）的**离线优先**作业手册，**无后端、无任何在线服务**。
维护员在有网时完整下载并校验某一手册版本后，断网仍可打开页面、查阅**正确的断电步骤**、
进行**离线故障演练**。

## 核心保证

- 应用内置**两个手册版本**（`1.0.0` / `2.0.0`）。每个版本的清单含：
  - 版本号、发布时间、标题；
  - 同源资源 URL 与各自的 **SHA-256**（`manifest.json` 含**有序步骤**，`faults.json` 含故障条目）；
  - 步骤数量。
- **原子安装与切换**：一个版本的所有资源必须**全部下载且 SHA-256 校验通过**，才会写入新的
  “当前代际”。在此之前页面始终展示此前的完整版本。
- **多标签页一致**：安装与启动清理都在**跨页面互斥锁（Web Locks）**内进行，同一时刻全浏览器
  只有一个安装。并行点击时未获锁的请求**直接落败**——不写 IndexedDB、不触碰任何缓存——
  转为跟随胜者进度；因此并行安装只会留下**唯一、完整且可离线读取**的最终版本，
  落败/失败的安装不会删除胜出版本及原有可用版本。每次状态变更经 **BroadcastChannel**
  广播，其他页面重读 IndexedDB **收敛到同一版本**：旧版未完成演练立即终止，
  已完成的演练结论保持原版本归属；跟随页还可取消他页进行中的安装。
- **半包永不上线**：取消、断网、校验失败、存储配额异常，或“安装中途关闭后重开”，
  都会**清理未激活的暂存缓存**，继续展示旧版；从未成功安装时显示
  **“无可用离线包”**。
- **中断新版安装后离线刷新，仍打开旧版**；只有**完整重装并激活**后，页面才只显示新版步骤。
- **离线演练**：搜索**当前版**故障条目 → **依序勾选**动作 → 得到**与版本绑定的通过结论**；
  切换版本会**终止未完成演练**。
- 离线读取由 **Service Worker + Cache Storage** 负责；
  **IndexedDB 只保存当前代际与安装状态**一条记录，不存手册正文。
- 浏览器缺少 Service Worker / Cache Storage / IndexedDB / Web Crypto 等能力时，页面显示
  **`UNSUPPORTED`**，不降级、不提供占位实现。

## 目录结构

```
public/manuals/v1|v2/        两个内置版本的同源资源（有序步骤 + 故障条目）
scripts/generate-catalog.mjs 扫描资源并计算 SHA-256，生成 src/manuals/catalog.json
src/core/                    纯逻辑（无 DOM 依赖）
  installer.ts               安装状态协调器（跨页面互斥锁内：下载→校验→原子提交；
                             失败/中断清理；BroadcastChannel 广播收敛）
  drill.ts                   演练：搜索、依序勾选、版本绑定结论、切版终止
  idb.ts                     IndexedDB 仅存“当前代际 + 安装状态”
src/service-worker/          SW：手册只从当前激活代际缓存读取，应用壳预缓存
src/platform/                浏览器端口（Cache/fetch/WebCrypto）、能力检测、SW 注册
src/components/              React UI（安装管理、步骤、离线演练）
src/test/fault-injection.ts  仅用于端到端的 SW 故障注入（无规则时完全透传，不影响生产）
plugins/sw-build.ts          构建期用 esbuild 编译 SW 并注入应用壳预缓存清单
e2e/                         Playwright：中断安装、离线重载、演练、首次失败、UNSUPPORTED、多标签页并行安装
```

## 本地开发

```bash
npm install
npm run dev        # http://localhost:5173（开发模式 SW 网络优先，支持 HMR）
```

## 构建与测试

```bash
npm run build      # 生成目录 + tsc 类型检查 + Vite 生产构建（含 SW 与预缓存清单）
npm run preview    # 本地静态预览（默认 http://localhost:4173）

npm run test       # Vitest：状态协调（取消/断网/校验/配额/中断重开/同版重装/升级回收/跨页并发）
npm run e2e        # Playwright：中断安装与离线重载、离线演练、首次失败、UNSUPPORTED、多标签页并行
npm run verify     # 类型检查 + 单测 + 构建 + Playwright，一键全量验收
```

> Service Worker 需要安全上下文：`https` 或 `localhost`。生产请用 `https` 或经 `localhost`
> 访问；非安全上下文会显示 `UNSUPPORTED`。

## Docker Compose

以 Nginx 纯静态托管，宿主端口可用 **`WEB_PORT`** 覆盖（默认 `8080`）：

```bash
docker compose up -d --build web          # http://localhost:8080
WEB_PORT=9000 docker compose up -d web    # http://localhost:9000
```

一次性**验收服务**（类型检查 → 单测 → 构建 → Playwright，跑完即退出，退出码即结论）：

```bash
docker compose up --build verify
```

`verify` 通过内网 `http://web` 访问已健康检查通过的 `web` 容器，不占用宿主端口。

## 清除缓存的方法

本应用的离线数据分三处，用途不同；排查问题或重置时按下表清理。

### 1. 浏览器 DevTools（推荐）

1. 打开页面 → F12 → **Application** 面板。
2. **Storage** → 点击 **Clear site data**（会同时清掉下面三类）。
3. 或分别清理：
   - **Service Workers** → 对本站点 **Unregister**；
   - **Cache Storage** → 删除 `shell:*`（应用壳）与所有 `manual:*`（手册代际/暂存）；
   - **IndexedDB** → 删除 `manual-kiosk-db`（仅含当前代际与安装状态）。
4. **硬刷新**：Windows/Linux `Ctrl+Shift+R`，macOS `Cmd+Shift+R`。

### 2. 命令行（无头 / 自动化环境）

在站点页面上下文执行：

```js
(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((r) => r.unregister()));     // 注销 SW
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));  // 清空 Cache Storage
  indexedDB.deleteDatabase('manual-kiosk-db');           // 删除代际状态
  location.reload();
})();
```

### 3. Docker 场景

```bash
docker compose down -v        # 停止并移除卷；镜像侧无状态，重建即获得全新产物
docker compose up -d --build web
```

> 缓存命名约定：`shell:<sw-version>` 为应用壳；`manual:stage:<version>:<attempt>`
> 为某次安装的暂存缓存。**手册请求只会命中 IndexedDB 当前指针所指的那一个缓存**，
> 任何暂存/半包缓存对外都不可见，因此清缓存或异常中断都不会让半包顶替旧手册。

## 安装状态机（速查）

```
idle ──install──▶ installing ──全部资源 SHA-256 通过──▶ activated（提交新代际→回收旧缓存）
                       │
                       ├─ 取消 / abort ─────▶ failed(canceled) ─┐
                       ├─ 断网 / 非 2xx ───▶ failed(network)  ─┤ 清理本次暂存缓存
                       ├─ SHA-256 不符 ────▶ failed(checksum) ─┤ 已激活版本不受影响
                       └─ 配额异常 ────────▶ failed(quota)    ─┘
（安装中途进程被杀 → IDB 留下 pending → 下次启动 init() 清理半包并恢复旧版）
```

多标签页：install 与 init 清理都先竞争**跨页面安装锁**；未获锁的 install 直接落败并
跟随胜者广播（不进入上图流程），获锁方状态变更经 BroadcastChannel 同步到所有页面。
