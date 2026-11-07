import { HybridRedactPreviewInput, type HybridRedactPreview, type HybridStatus } from '@srh/shared';
import { hybridStatus, localHealth, redactPreview } from '../../agents/llm/hybrid';
import { parse } from '../../lib/http';
import { requireUser } from '../auth/guard';
import type { ModuleDef } from '../types';

/**
 * 混合 AI 看板（ARCHITECTURE.md §7.7）：本地模型状态、分流规则、调用统计，与隐私护栏试运行。
 * 统计是全站的（进程内存），不含任何正文，所以登录用户都能看。
 */
export const hybridModule: ModuleDef = {
  name: 'hybrid',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    app.get<{ Querystring: { refresh?: string } }>(
      '/hybrid/status',
      async (req): Promise<HybridStatus> => {
        await requireUser(req);
        if (req.query.refresh === '1') await localHealth(ctx.config, true);
        return hybridStatus(ctx.config);
      },
    );

    app.post('/hybrid/redact-preview', async (req): Promise<HybridRedactPreview> => {
      await requireUser(req);
      const { text } = parse(HybridRedactPreviewInput, req.body);
      return redactPreview(ctx.config, text);
    });
  },
};
