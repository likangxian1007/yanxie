import { defaultModelId } from '../../agents/llm/registry';
import type { HealthResponse } from '@srh/shared';
import type { ModuleDef } from '../types';

/**
 * GET /api/health —— 部署与前端状态点使用。注意不在 /api/v1 下。
 * 数据库可用 → 200 status=ok；否则 503 status=degraded。
 */
export const healthModule: ModuleDef = {
  name: 'health',
  owner: 'foundation',
  register(app) {
    app.get('/api/health', async (_req, reply) => {
      const { config, db, version, startedAt } = app.ctx;
      let dbStatus: HealthResponse['db'];
      try {
        const latencyMs = await db.ping();
        dbStatus = { ok: true, driver: db.driver, latencyMs };
      } catch (err) {
        dbStatus = {
          ok: false,
          driver: db.driver,
          latencyMs: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const body: HealthResponse = {
        status: dbStatus.ok ? 'ok' : 'degraded',
        version,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        time: new Date().toISOString(),
        db: dbStatus,
        llm: { configured: config.llmConfigured, model: defaultModelId(config) },
      };
      return reply.status(dbStatus.ok ? 200 : 503).send(body);
    });
  },
};
