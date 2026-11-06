/** 独立执行迁移：`pnpm db:migrate`，或镜像内 `node dist/migrate.js`。 */
import 'dotenv/config';
import { loadConfig } from '../config';
import { createDb } from './client';
import { migrationsFolder } from './migrate';

const config = loadConfig();
const handle = await createDb(config.DATABASE_URL);
const folder = migrationsFolder();
await handle.migrate(folder);
console.log(`[migrate] 完成（${handle.driver}，${folder}）`);
await handle.close();
