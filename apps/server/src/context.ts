import type { AppConfig } from './config';
import type { DbHandle } from './db/client';
import type { EventBus } from './realtime/bus';
import type { AccessPolicy } from './realtime/access';

/**
 * 应用上下文：所有模块通过 `app.ctx` 拿到，不要各自 new 连接或读 env。
 */
export interface AppContext {
  config: AppConfig;
  /** 数据库句柄；查询用 ctx.db.db */
  db: DbHandle;
  bus: EventBus;
  access: AccessPolicy;
  version: string;
  startedAt: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
