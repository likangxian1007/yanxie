import { defineConfig } from 'drizzle-kit';

/**
 * 生成迁移：改完 src/db/schema/*.ts 后运行 `pnpm db:generate`。
 * 多线程并行时：先 rebase 到最新 main，再生成，保证迁移编号连续（见 ARCHITECTURE.md §8）。
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
});
