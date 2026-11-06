# syntax=docker/dockerfile:1
# 单镜像：Node 服务同时托管前端构建产物（/app/web），端口 8787。

FROM node:24-alpine AS base
RUN npm install -g pnpm@11.21.0
WORKDIR /app

# ---- 依赖（利用缓存：只拷 manifest）----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
# 落地页不进镜像，但 manifest 要在，冻结安装才与 lockfile 的工作区清单一致
COPY apps/landing/package.json apps/landing/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# ---- 构建 ----
FROM deps AS build
# 部署子路径（例如 /app/）：前端的资源、路由、API 与 WebSocket 地址都带上它；默认根路径
ARG VITE_BASE_PATH=/
COPY . .
RUN VITE_BASE_PATH="$VITE_BASE_PATH" pnpm --filter @srh/web build \
 && pnpm --filter @srh/server build \
 && pnpm --filter @srh/server deploy --prod --legacy /out

# ---- LaTeX 编译器（Tectonic，静态 musl 版）----
# 文档里的 LaTeX 工程用它真编译（XeTeX，自动跑 BibTeX，ctex 中文可用）。宏包按需下载到 LATEX_CACHE_DIR（持久卷）。
FROM alpine:3.22 AS tectonic
ARG TECTONIC_VERSION=0.17.0
ARG TARGETARCH
RUN apk add --no-cache curl \
 && case "${TARGETARCH:-amd64}" in \
      amd64) triple=x86_64-unknown-linux-musl ;; \
      arm64) triple=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${triple}.tar.gz" \
    | tar -xz -C /usr/local/bin tectonic \
 && /usr/local/bin/tectonic --version

# ---- 运行 ----
FROM node:24-alpine AS runtime
# Notebook 导出 PDF 用无头 Chromium + 中文字体（导出时 JS 关闭、离线打印）
RUN apk add --no-cache ca-certificates fontconfig chromium font-noto-cjk
COPY --from=tectonic /usr/local/bin/tectonic /usr/local/bin/tectonic
ENV NODE_ENV=production \
    PDF_CHROMIUM_PATH=/usr/bin/chromium-browser \
    PORT=8787 \
    HOST=0.0.0.0 \
    WEB_DIST_DIR=/app/web \
    STORAGE_DIR=/data/storage \
    MIGRATIONS_DIR=/app/drizzle \
    PROMPTS_DIR=/app/prompts \
    LATEX_COMPILER=tectonic \
    LATEX_CACHE_DIR=/data/latex-cache \
    OCR_LANG_DIR=/data/ocr-lang
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle
# agent 的 system prompt（运行时读取，见 apps/server/prompts/README.md）
COPY --from=build /app/apps/server/prompts ./prompts
COPY --from=build /app/apps/web/dist ./web
RUN mkdir -p /data/storage /data/latex-cache /data/ocr-lang && chown -R node:node /data /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
