import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * 数据库连接。两种驱动，同一套 schema / 查询代码：
 * - postgres：DATABASE_URL=postgres://…（Docker Compose、生产）
 * - pglite：DATABASE_URL 为空或 `pglite:<目录|memory>`（本地开发、测试，零安装）
 * 业务代码只依赖 `Db` 类型，不要 import 具体驱动。
 */
export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type DbDriver = 'postgres' | 'pglite';

export interface DbHandle {
  db: Db;
  driver: DbDriver;
  /** 执行迁移（drizzle/ 目录下的 SQL） */
  migrate: (migrationsFolder: string) => Promise<void>;
  /** 健康检查：返回往返耗时（毫秒） */
  ping: () => Promise<number>;
  close: () => Promise<void>;
}

export async function createDb(url: string): Promise<DbHandle> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 3000 });
    // 空闲连接出错（如 Postgres 重启）不能让进程崩溃；下一次查询会自动重连
    pool.on('error', (err) => console.error('[db] idle client error', err.message));
    const db = drizzle(pool, { schema });
    return {
      db: db as unknown as Db,
      driver: 'postgres',
      migrate: (folder) => migrate(db, { migrationsFolder: folder }),
      ping: () => timed(() => db.execute(sql`select 1`)),
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const target = url.replace(/^pglite:/u, '');
  let client: InstanceType<typeof PGlite>;
  if (target === 'memory') {
    client = new PGlite();
  } else {
    const dir = resolve(target || '.data/pglite');
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  await client.waitReady;
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Db,
    driver: 'pglite',
    migrate: (folder) => migrate(db, { migrationsFolder: folder }),
    ping: () => timed(() => db.execute(sql`select 1`)),
    close: () => client.close(),
  };
}

/** 计时并限时 3s：健康检查不能因为数据库卡住而一直挂着 */
async function timed(fn: () => Promise<unknown>, timeoutMs = 3000): Promise<number> {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`数据库 ${timeoutMs}ms 内无响应`)), timeoutMs);
  });
  try {
    await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return Math.round((performance.now() - start) * 10) / 10;
}
