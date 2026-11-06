import { defineConfig } from 'tsup';

/**
 * 生产构建：把 src 与 @srh/shared 打成 dist/index.js（服务）和 dist/migrate.js（独立迁移）。
 * 第三方依赖保持 external，由镜像里的 node_modules 提供。
 */
export default defineConfig({
  entry: { index: 'src/index.ts', migrate: 'src/db/migrate-cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ['@srh/shared'],
});
