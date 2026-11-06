import { z } from 'zod';
import {
  ApiError,
  EvidenceExcerptCreateInput,
  PageQuery,
  ResearchCodeCreateInput,
  ResearchCodeUpdateInput,
  ResearchCodingCreateInput,
  ResearchFindingCreateInput,
  ResearchFindingUpdateInput,
  ResearchLogCreateInput,
  ResearchRecordCreateInput,
  ResearchRecordUpdateInput,
  ResearchSnapshotCreateInput,
  ResearchSourceCreateInput,
  ResearchSourceUpdateInput,
  ResearchTemplatePublishInput,
  type ResearchRecord,
  type ResearchFinding,
  type ResearchSource,
} from '@srh/shared';
import type { FastifyRequest } from 'fastify';
import { parse } from '../../lib/http';
import { requireProject } from '../collab-common';
import type { ModuleDef } from '../types';
import {
  addLog,
  allEntities,
  createCode,
  createCoding,
  createExcerpt,
  createFinding,
  createLinkedSource,
  createRecord,
  createSnapshot,
  getEntity,
  getTemplate,
  listEntities,
  listRevisions,
  listTemplates,
  publishTemplate,
  readSnapshotBytes,
  recordDetail,
  sourceAvailability,
  updateCode,
  updateFinding,
  updateRecord,
  updateSource,
} from './service';
import { exportResearch } from './export';
import { startResearchSourceHooks } from './hooks';
import { searchWorkspaceItems, listWorkspaceActivity } from './workspace';
import { registerWorkspaceRoutes } from './workspace-routes';
import { registerResearchExecutionRoutes } from './execution-routes';
import { registerResearchLayoutRoutes } from './layout-routes';

type P = { projectId: string };
type PR = P & { recordId: string };
type PS = P & { sourceId: string };
type PI = P & { snapshotId: string };
type PC = P & { codeId: string };
type PF = P & { findingId: string };
const RecordListQuery = PageQuery.extend({
  method: z.string().optional(),
  status: z.string().optional(),
});
const SourceListQuery = PageQuery.extend({ recordId: z.string().optional() });
const CodingListQuery = PageQuery.extend({ caseId: z.string().optional() });
const ExportQuery = z.object({ format: z.enum(['json', 'markdown', 'csv']).default('json') });
const SearchQuery = PageQuery.extend({ q: z.string().trim().min(1).max(200) });
const VersionParams = z.object({ version: z.coerce.number().int().positive() });

function pageAfter<T extends { id: string }>(
  items: T[],
  query: { cursor?: string; limit: number },
) {
  const start = query.cursor ? items.findIndex((x) => x.id === query.cursor) + 1 : 0;
  if (query.cursor && start === 0) throw new ApiError('validation_failed', '分页游标无效');
  return {
    items: items.slice(start, start + query.limit),
    nextCursor: items.length > start + query.limit ? items[start + query.limit - 1]!.id : null,
  };
}

function key(req: FastifyRequest, body: { idempotencyKey?: string }) {
  const header = req.headers['idempotency-key'];
  if (header && (typeof header !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/u.test(header))) {
    throw new ApiError('validation_failed', '幂等键格式不正确');
  }
  if (header && body.idempotencyKey && header !== body.idempotencyKey)
    throw new ApiError('validation_failed', '请求头和请求体的幂等键不一致');
  return (header as string | undefined) ?? body.idempotencyKey;
}

export const researchModule: ModuleDef = {
  name: 'research',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;
    startResearchSourceHooks(ctx);
    registerWorkspaceRoutes(app);
    registerResearchLayoutRoutes(app);
    registerResearchExecutionRoutes(app);
    app.get<{ Params: P }>('/projects/:projectId/research/templates', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return listTemplates(ctx, req.params.projectId, parse(PageQuery, req.query));
    });
    app.post<{ Params: P }>('/projects/:projectId/research/templates', async (req, reply) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      const input = parse(ResearchTemplatePublishInput, req.body);
      const dto = await publishTemplate(ctx, actor, req.params.projectId, {
        ...input,
        idempotencyKey: key(req, input),
      });
      return reply.status(201).send(dto);
    });
    app.get<{ Params: P & { templateId: string; version: string } }>(
      '/projects/:projectId/research/templates/:templateId/versions/:version',
      async (req) => {
        await requireProject(req, req.params.projectId, 'view');
        const { version } = parse(VersionParams, req.params);
        return getTemplate(ctx, req.params.projectId, req.params.templateId, version);
      },
    );
    app.get<{ Params: P }>('/projects/:projectId/research', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      const { cursor, limit } = parse(PageQuery, req.query);
      const records = (await allEntities<ResearchRecord>(ctx, req.params.projectId, 'record')).map(
        (r) => ({
          kind: 'research' as const,
          id: r.id,
          projectId: r.projectId,
          title: r.title,
          status: r.status,
          method: r.method,
          updatedAt: r.updatedAt,
          href: `/p/${r.projectId}/research/${r.id}`,
        }),
      );
      const activity = await listWorkspaceActivity(
        ctx,
        req.params.projectId,
        records.map((record) => record.id),
      );
      for (const record of records) {
        const changedAt = activity.get(record.id);
        if (changedAt && changedAt > record.updatedAt) record.updatedAt = changedAt;
      }
      const all = records.sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      );
      return pageAfter(all, { cursor, limit });
    });
    app.get<{ Params: P }>('/projects/:projectId/research/search', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      const query = parse(SearchQuery, req.query);
      const needle = query.q.toLocaleLowerCase();
      const [records, sources, findings, workspaceItems] = await Promise.all([
        allEntities<ResearchRecord>(ctx, req.params.projectId, 'record'),
        allEntities<ResearchSource>(ctx, req.params.projectId, 'source'),
        allEntities<ResearchFinding>(ctx, req.params.projectId, 'finding'),
        searchWorkspaceItems(ctx, req.params.projectId, {
          q: query.q,
          limit: query.limit + 1,
          cursor: query.cursor,
        }),
      ]);
      const hits = [
        ...workspaceItems,
        ...records
          .filter((r) => `${r.title} ${r.question}`.toLocaleLowerCase().includes(needle))
          .map((r) => ({
            kind: 'record' as const,
            id: r.id,
            projectId: r.projectId,
            recordId: r.id,
            title: r.title,
            snippet: r.question.slice(0, 300),
            href: `/p/${r.projectId}/research/${r.id}`,
          })),
        ...sources
          .filter((s) => `${s.title} ${s.citation}`.toLocaleLowerCase().includes(needle))
          .map((s) => ({
            kind: 'source' as const,
            id: s.id,
            projectId: s.projectId,
            recordId: s.recordId,
            title: s.title,
            snippet: s.citation.slice(0, 300),
            href: `/p/${s.projectId}/research-sources/${s.id}`,
          })),
        ...findings
          .filter((f) => f.statement.toLocaleLowerCase().includes(needle))
          .map((f) => ({
            kind: 'finding' as const,
            id: f.id,
            projectId: f.projectId,
            recordId: f.recordId,
            title: f.statement.slice(0, 120),
            snippet: f.limitations.slice(0, 300),
            href: `/p/${f.projectId}/research-findings/${f.id}`,
          })),
      ]
        .filter((hit) => !query.cursor || hit.id < query.cursor)
        .sort((a, b) => b.id.localeCompare(a.id));
      const items = hits.slice(0, query.limit);
      return { items, nextCursor: hits.length > query.limit ? items.at(-1)!.id : null };
    });
    app.get<{ Params: P }>('/projects/:projectId/research/records', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      const q = parse(RecordListQuery, req.query);
      const all = (await allEntities<ResearchRecord>(ctx, req.params.projectId, 'record')).filter(
        (r) => (!q.method || r.method === q.method) && (!q.status || r.status === q.status),
      );
      return pageAfter(all, q);
    });
    app.post<{ Params: P }>('/projects/:projectId/research/records', async (req, reply) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      const input = parse(ResearchRecordCreateInput, req.body);
      const dto = await createRecord(ctx, actor, req.params.projectId, {
        ...input,
        idempotencyKey: key(req, input),
      });
      return reply.status(201).send(dto);
    });
    app.get<{ Params: PR }>('/projects/:projectId/research/records/:recordId', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return recordDetail(ctx, req.params.projectId, req.params.recordId);
    });
    app.patch<{ Params: PR }>('/projects/:projectId/research/records/:recordId', async (req) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      return updateRecord(
        ctx,
        actor,
        req.params.projectId,
        req.params.recordId,
        parse(ResearchRecordUpdateInput, req.body),
      );
    });
    app.get<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/revisions',
      async (req) => {
        await requireProject(req, req.params.projectId, 'view');
        return listRevisions(
          ctx,
          req.params.projectId,
          req.params.recordId,
          parse(PageQuery, req.query),
        );
      },
    );
    app.get<{ Params: PR }>('/projects/:projectId/research/records/:recordId/logs', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      await getEntity<ResearchRecord>(ctx, req.params.projectId, 'record', req.params.recordId);
      return listEntities(ctx, req.params.projectId, 'log', {
        ...parse(PageQuery, req.query),
        recordId: req.params.recordId,
      });
    });
    app.post<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/logs',
      async (req, reply) => {
        const { actor } = await requireProject(req, req.params.projectId, 'write');
        const input = parse(ResearchLogCreateInput, req.body);
        return reply.status(201).send(
          await addLog(ctx, actor, req.params.projectId, req.params.recordId, {
            ...input,
            idempotencyKey: key(req, input),
          }),
        );
      },
    );
    app.get<{ Params: P }>('/projects/:projectId/research/sources', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      const q = parse(SourceListQuery, req.query);
      if (!q.recordId) return listEntities<ResearchSource>(ctx, req.params.projectId, 'source', q);
      const record = await getEntity<ResearchRecord>(
        ctx,
        req.params.projectId,
        'record',
        q.recordId,
      );
      return pageAfter(
        (await allEntities<ResearchSource>(ctx, req.params.projectId, 'source')).filter((s) =>
          record.sourceIds.includes(s.id),
        ),
        q,
      );
    });
    app.post<{ Params: P }>('/projects/:projectId/research/sources', async (req, reply) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      const input = parse(ResearchSourceCreateInput, req.body);
      return reply.status(201).send(
        await createLinkedSource(ctx, actor, req.params.projectId, {
          ...input,
          idempotencyKey: key(req, input),
        }),
      );
    });
    app.get<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/sources',
      async (req) => {
        await requireProject(req, req.params.projectId, 'view');
        const record = await getEntity<ResearchRecord>(
          ctx,
          req.params.projectId,
          'record',
          req.params.recordId,
        );
        const q = parse(PageQuery, req.query);
        return pageAfter(
          (await allEntities<ResearchSource>(ctx, req.params.projectId, 'source')).filter((s) =>
            record.sourceIds.includes(s.id),
          ),
          q,
        );
      },
    );
    app.post<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/sources',
      async (req, reply) => {
        const { actor } = await requireProject(req, req.params.projectId, 'write');
        const input = parse(ResearchSourceCreateInput, req.body);
        const source = await createLinkedSource(ctx, actor, req.params.projectId, {
          ...input,
          recordId: req.params.recordId,
          idempotencyKey: key(req, input),
        });
        return reply.status(201).send(source);
      },
    );
    app.patch<{ Params: PS }>('/projects/:projectId/research/sources/:sourceId', async (req) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      return updateSource(
        ctx,
        actor,
        req.params.projectId,
        req.params.sourceId,
        parse(ResearchSourceUpdateInput, req.body),
      );
    });
    app.get<{ Params: PS }>(
      '/projects/:projectId/research/sources/:sourceId/availability',
      async (req) => {
        await requireProject(req, req.params.projectId, 'view');
        return sourceAvailability(ctx, req.params.projectId, req.params.sourceId);
      },
    );
    app.get<{ Params: PS }>(
      '/projects/:projectId/research/sources/:sourceId/snapshots',
      async (req) => {
        await requireProject(req, req.params.projectId, 'view');
        await getEntity<ResearchSource>(ctx, req.params.projectId, 'source', req.params.sourceId);
        const q = parse(PageQuery, req.query);
        return pageAfter(
          (
            await allEntities<{ id: string; sourceId: string }>(
              ctx,
              req.params.projectId,
              'snapshot',
            )
          ).filter((s) => s.sourceId === req.params.sourceId),
          q,
        );
      },
    );
    app.post<{ Params: PS }>(
      '/projects/:projectId/research/sources/:sourceId/snapshots',
      async (req, reply) => {
        const { actor } = await requireProject(req, req.params.projectId, 'write');
        const input = parse(ResearchSnapshotCreateInput, req.body);
        return reply.status(201).send(
          await createSnapshot(ctx, actor, req.params.projectId, req.params.sourceId, {
            ...input,
            idempotencyKey: key(req, input),
          }),
        );
      },
    );
    app.get<{ Params: PI }>('/projects/:projectId/research/snapshots/:snapshotId', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return getEntity(ctx, req.params.projectId, 'snapshot', req.params.snapshotId);
    });
    app.get<{ Params: PI }>(
      '/projects/:projectId/research/snapshots/:snapshotId/download',
      async (req, reply) => {
        await requireProject(req, req.params.projectId, 'view');
        const { snapshot, bytes } = await readSnapshotBytes(
          ctx,
          req.params.projectId,
          req.params.snapshotId,
        );
        reply.header(
          'content-type',
          snapshot.mime === 'text/html' ? 'application/octet-stream' : snapshot.mime,
        );
        reply.header('content-disposition', `attachment; filename="${snapshot.id}"`);
        return reply.send(bytes);
      },
    );
    app.get<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/excerpts',
      async (req) => {
        await requireProject(req, req.params.projectId, 'view');
        await getEntity<ResearchRecord>(ctx, req.params.projectId, 'record', req.params.recordId);
        return listEntities(ctx, req.params.projectId, 'excerpt', {
          ...parse(PageQuery, req.query),
          recordId: req.params.recordId,
        });
      },
    );
    app.post<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/excerpts',
      async (req, reply) => {
        const { actor } = await requireProject(req, req.params.projectId, 'write');
        const input = parse(EvidenceExcerptCreateInput, req.body);
        return reply.status(201).send(
          await createExcerpt(ctx, actor, req.params.projectId, req.params.recordId, {
            ...input,
            idempotencyKey: key(req, input),
          }),
        );
      },
    );
    app.get<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/codes',
      async (req) => {
        await requireProject(req, req.params.projectId, 'view');
        await getEntity<ResearchRecord>(ctx, req.params.projectId, 'record', req.params.recordId);
        return listEntities(ctx, req.params.projectId, 'code', {
          ...parse(PageQuery, req.query),
          recordId: req.params.recordId,
        });
      },
    );
    app.post<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/codes',
      async (req, reply) => {
        const { actor } = await requireProject(req, req.params.projectId, 'write');
        const input = parse(ResearchCodeCreateInput, req.body);
        return reply.status(201).send(
          await createCode(ctx, actor, req.params.projectId, req.params.recordId, {
            ...input,
            idempotencyKey: key(req, input),
          }),
        );
      },
    );
    app.patch<{ Params: PC }>('/projects/:projectId/research/codes/:codeId', async (req) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      return updateCode(
        ctx,
        actor,
        req.params.projectId,
        req.params.codeId,
        parse(ResearchCodeUpdateInput, req.body),
      );
    });
    app.get<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/codings',
      async (req) => {
        await requireProject(req, req.params.projectId, 'view');
        await getEntity<ResearchRecord>(ctx, req.params.projectId, 'record', req.params.recordId);
        const q = parse(CodingListQuery, req.query);
        const all = (
          await allEntities<{ id: string; recordId: string; caseId: string | null }>(
            ctx,
            req.params.projectId,
            'coding',
          )
        ).filter((x) => x.recordId === req.params.recordId && (!q.caseId || x.caseId === q.caseId));
        return pageAfter(all, q);
      },
    );
    app.post<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/codings',
      async (req, reply) => {
        const { actor } = await requireProject(req, req.params.projectId, 'write');
        const input = parse(ResearchCodingCreateInput, req.body);
        return reply.status(201).send(
          await createCoding(ctx, actor, req.params.projectId, req.params.recordId, {
            ...input,
            idempotencyKey: key(req, input),
          }),
        );
      },
    );
    app.get<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/findings',
      async (req) => {
        await requireProject(req, req.params.projectId, 'view');
        await getEntity<ResearchRecord>(ctx, req.params.projectId, 'record', req.params.recordId);
        return listEntities(ctx, req.params.projectId, 'finding', {
          ...parse(PageQuery, req.query),
          recordId: req.params.recordId,
        });
      },
    );
    app.post<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/findings',
      async (req, reply) => {
        const { actor } = await requireProject(req, req.params.projectId, 'write');
        const input = parse(ResearchFindingCreateInput, req.body);
        return reply.status(201).send(
          await createFinding(ctx, actor, req.params.projectId, req.params.recordId, {
            ...input,
            idempotencyKey: key(req, input),
          }),
        );
      },
    );
    app.patch<{ Params: PF }>('/projects/:projectId/research/findings/:findingId', async (req) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      return updateFinding(
        ctx,
        actor,
        req.params.projectId,
        req.params.findingId,
        parse(ResearchFindingUpdateInput, req.body),
      );
    });
    app.get<{ Params: PF }>('/projects/:projectId/research/findings/:findingId', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return getEntity(ctx, req.params.projectId, 'finding', req.params.findingId);
    });
    app.get<{ Params: PR }>(
      '/projects/:projectId/research/records/:recordId/export',
      async (req, reply) => {
        await requireProject(req, req.params.projectId, 'view');
        const { format } = parse(ExportQuery, req.query);
        const output = await exportResearch(ctx, req.params.projectId, req.params.recordId, format);
        reply.header('content-type', output.mime);
        const extension = format === 'markdown' ? 'md' : format;
        reply.header(
          'content-disposition',
          `attachment; filename="research-${req.params.recordId}.${extension}"`,
        );
        return reply.send(output.body);
      },
    );
  },
};
