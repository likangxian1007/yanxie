import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { directUiImports } from './tooling/direct-ui-imports';

const API_TARGET = 'http://localhost:8787';
const WS_TARGET = 'ws://localhost:8787';

/**
 * 部署子路径（例如 `/app/`）：统一成首尾都带斜杠，未设置时为 `/`。
 * 反向代理剥掉前缀后再转给服务端；开发服务器与测试始终用根路径。
 */
function basePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/gu, '');
  return trimmed ? `/${trimmed}/` : '/';
}

const APP_VERSION = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export default defineConfig({
  base: process.env.VITEST ? '/' : basePath(process.env.VITE_BASE_PATH),
  define: {
    // 反馈诊断与前端报错上报带上构建版本
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    directUiImports(readFileSync(new URL('./src/components/ui/index.ts', import.meta.url), 'utf8')),
    react(),
    tailwindcss(),
  ],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
      '/collab': { target: WS_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: {
    rolldownOptions: {
      treeshake: {
        // shared 仅声明契约/解析器，不注册全局行为。未使用的 schema 模块不必执行初始化。
        // 保留其余模块的默认副作用语义，尤其是 CSS、字体和第三方运行时。
        moduleSideEffects: (id) => !/[\\/]packages[\\/]shared[\\/]src[\\/]/u.test(id),
      },
      output: {
        // 只合并实际首屏可达的小模块，避免每个图标/工具函数各发一个请求。
        // 页面导入已展开，Markdown/编辑器等按所在页面独立加载。
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/,
              priority: 30,
            },
            {
              name: 'motion',
              test: /[\\/]node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/,
              priority: 30,
            },
            // 首屏用到的图标合成一块；只在懒加载页面里用到的图标合成另一块（第一次进协作页时下载）
            {
              name: 'icons',
              test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
              tags: ['$initial'],
              priority: 20,
            },
            {
              name: 'icons-more',
              test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
              priority: 19,
            },
            {
              name: 'vendor',
              test: /[\\/]node_modules[\\/]/,
              tags: ['$initial'],
              priority: 10,
            },
            {
              name: 'app-common',
              test: (id) => /[\\/]src[\\/]/.test(id) && !/[\\/]src[\\/]main\.tsx$/.test(id),
              tags: ['$initial'],
              maxModuleSize: 8 * 1024,
              priority: 5,
            },
          ],
        },
      },
    },
  },
  preview: {
    port: 4173,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    // 整个 App 渲染的集成测试在并行负载下可能超过默认 5s
    testTimeout: 20_000,
  },
});
