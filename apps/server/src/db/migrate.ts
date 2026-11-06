import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 找到 drizzle 迁移目录：开发时在 apps/server/drizzle，
 * 构建后（dist/）与 Docker 镜像里在 dist/../drizzle。
 */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR,
    resolve(here, '../../drizzle'), // src/db → apps/server/drizzle
    resolve(here, '../drizzle'), // dist → apps/server/drizzle
    resolve(process.cwd(), 'drizzle'),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(resolve(p, 'meta/_journal.json')));
  if (!found) throw new Error(`找不到数据库迁移目录，已尝试：${candidates.join(', ')}`);
  return found;
}
