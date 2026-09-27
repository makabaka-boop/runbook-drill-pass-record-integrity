# syntax=docker/dockerfile:1

# ---- 构建阶段：安装依赖、生成目录、类型检查、构建产物 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 先拷贝依赖清单，利用层缓存
COPY package.json package-lock.json* ./
RUN npm ci

# 拷贝源码与资源，生成内置手册目录并构建
COPY tsconfig.json vite.config.ts index.html ./
COPY plugins ./plugins
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build

# ---- 运行阶段：Nginx 纯静态托管（无后端、无在线服务）----
FROM nginx:1.27-alpine AS web
# SPA 回退 + 正确 MIME；SW 不缓存
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

# ---- 验收阶段：一次性 verify 服务 ----
FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS verify
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json vite.config.ts playwright.config.ts index.html ./
COPY plugins ./plugins
COPY scripts ./scripts
COPY src ./src
COPY public ./public
COPY e2e ./e2e
# 不在此处构建：verify 对 web 容器已托管的产物做端到端验证，
# 但仍需本地构建产物完成 typecheck/单测/构建三步。
ENV BASE_URL=http://web
ENV PW_NO_WEB_SERVER=1
CMD ["sh", "-c", "npm run typecheck && npm run test && npm run build && npx playwright test"]
