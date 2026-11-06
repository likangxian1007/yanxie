import { defaultModelId } from './agents/llm/registry';
import 'dotenv/config';
import { startAgentRuntime } from './agents/runtime';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { migrationsFolder } from './db/migrate';

/**
 * 进程入口：读配置 → 连库 → （可选）迁移 → 启动 HTTP/WS → 优雅退出。
 * agent 运行时（agents/runtime）由后端线程在这里接入：订阅 bus 事件、调度 turn。
 */
// 日志系统要等 buildApp 完成才可用；提前标记阶段，便于定位开发环境启动停顿。
// 不输出配置内容、数据库地址或模型凭据。
console.log('[启动 1/5] 正在读取配置');
const config = loadConfig();
console.log('[启动 2/5] 正在连接数据库');
const db = await createDb(config.DATABASE_URL);
if (config.DB_AUTO_MIGRATE) {
  console.log('[启动 3/5] 正在执行数据库迁移');
  await db.migrate(migrationsFolder());
} else {
  console.log('[启动 3/5] 自动迁移未启用，跳过');
}

console.log('[启动 4/5] 正在注册接口与协作服务');
const app = await buildApp({ config, db, version: process.env.npm_package_version ?? '0.1.0' });
app.log.info(
  `数据库：${db.driver}；平台默认模型：${config.llmConfigured ? defaultModelId(config) : '未配置（项目模型在调用时读取）'}`,
);

console.log(`[启动 5/5] 正在监听端口 ${config.PORT}`);
await app.listen({ port: config.PORT, host: config.HOST });
console.log(`[启动完成] 后端已监听端口 ${config.PORT}`);

// 项目模型在调用时读取，支持从设置页配置后直接使用。
const runtime = startAgentRuntime(app.ctx);
app.log.info('agent 运行时已启动，按会话使用平台或项目模型');

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info(`收到 ${signal}，正在关闭`);
  await runtime?.stop();
  await app.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
