import { z } from 'zod';
import {
  EvidenceExcerptCreateInput,
  ResearchCodeCreateInput,
  ResearchCodingCreateInput,
  ResearchFindingCreateInput,
  ResearchFindingUpdateInput,
  ResearchRecordCreateInput,
  ResearchRecordUpdateInput,
  ResearchSnapshotCreateInput,
  ResearchSourceCreateInput,
  type ResearchRecord,
  type ResearchSource,
} from '@srh/shared';
import {
  addLog,
  createCode,
  createCoding,
  createExcerpt,
  createFinding,
  createLinkedSource,
  createRecord,
  createSnapshot,
  getEntity,
  listEntities,
  listTemplates,
  recordDetail,
  updateCode,
  updateFinding,
  updateRecord,
} from '../../modules/research/service';
import { exportResearch } from '../../modules/research/export';
import { requireCoveringClaim } from './collab';
import { ALL_ROLES, WORKER_ROLES, defineTool, type ToolContext, type ToolDef } from './types';

async function claim(tc: ToolContext, ref: string) {
  return requireCoveringClaim(
    tc,
    { resourceKind: 'research', resourceRef: ref },
    { label: '研究空间', suggestMode: 'exclusive' },
  );
}

export const researchTools: ToolDef[] = [
  defineTool({
    name: 'research_list',
    description: '列出本项目研究空间、来源或快照；templates 仅用于历史兼容，不作为工作入口。',
    roles: ALL_ROLES,
    schema: z.object({
      kind: z.enum(['templates', 'records', 'sources', 'snapshots']).default('records'),
      limit: z.number().int().min(1).max(100).default(30),
      cursor: z.string().optional(),
    }),
    async run(tc, args) {
      if (args.kind === 'templates') return listTemplates(tc.ctx, tc.project.id, args);
      if (args.kind === 'sources')
        return listEntities<ResearchSource>(tc.ctx, tc.project.id, 'source', args);
      if (args.kind === 'snapshots') return listEntities(tc.ctx, tc.project.id, 'snapshot', args);
      return listEntities<ResearchRecord>(tc.ctx, tc.project.id, 'record', args);
    },
  }),
  defineTool({
    name: 'research_read',
    description:
      '回读研究空间的历史字段、过程日志、来源及依据；当前内容用 research_workspace 的 list/read，不要求填写旧模板。',
    roles: ALL_ROLES,
    schema: z.union([
      z.object({ record_id: z.string(), include_evidence: z.boolean().default(true) }),
      z.object({ kind: z.literal('source'), source_id: z.string() }),
      z.object({ kind: z.literal('snapshot'), snapshot_id: z.string() }),
    ]),
    async run(tc, args) {
      if ('kind' in args && args.kind === 'source')
        return getEntity<ResearchSource>(tc.ctx, tc.project.id, 'source', args.source_id);
      if ('kind' in args && args.kind === 'snapshot')
        return getEntity(tc.ctx, tc.project.id, 'snapshot', args.snapshot_id);
      const detail = await recordDetail(tc.ctx, tc.project.id, args.record_id);
      if (!args.include_evidence) return detail;
      const [excerpts, codes, codings, findings] = await Promise.all([
        listEntities(tc.ctx, tc.project.id, 'excerpt', { recordId: args.record_id, limit: 100 }),
        listEntities(tc.ctx, tc.project.id, 'code', { recordId: args.record_id, limit: 100 }),
        listEntities(tc.ctx, tc.project.id, 'coding', { recordId: args.record_id, limit: 100 }),
        listEntities(tc.ctx, tc.project.id, 'finding', { recordId: args.record_id, limit: 100 }),
      ]);
      return {
        ...detail,
        excerpts: excerpts.items,
        codes: codes.items,
        codings: codings.items,
        findings: findings.items,
        note: '各列表最多返回前100项，完整记录可用research_export。',
      };
    },
  }),
  defineTool({
    name: 'research_create',
    description:
      '登记来源，先认领关联的研究空间或项目。新建研究用 research_workspace 的 workspace_create；record 分支仅兼容已有调用。',
    roles: WORKER_ROLES,
    schema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('record'), input: ResearchRecordCreateInput }),
      z.object({ kind: z.literal('source'), input: ResearchSourceCreateInput }),
    ]),
    async run(tc, args) {
      if (args.kind === 'record') {
        await claim(tc, 'new');
        return createRecord(tc.ctx, tc.actor, tc.project.id, args.input);
      }
      await claim(tc, args.input.recordId ?? tc.project.id);
      return createLinkedSource(tc.ctx, tc.actor, tc.project.id, args.input);
    },
  }),
  defineTool({
    name: 'research_update',
    description:
      '按 baseVersion 更新研究名称、问题或状态；历史字段操作仅为兼容，当前研究内容用 research_workspace 编辑。',
    roles: WORKER_ROLES,
    schema: z.object({ record_id: z.string(), change: ResearchRecordUpdateInput }),
    async run(tc, args) {
      await claim(tc, args.record_id);
      return updateRecord(tc.ctx, tc.actor, tc.project.id, args.record_id, args.change);
    },
  }),
  defineTool({
    name: 'research_log',
    description: '为研究空间追加不可覆盖的过程日志。',
    roles: WORKER_ROLES,
    schema: z.object({ record_id: z.string(), body: z.string().trim().min(1).max(20_000) }),
    async run(tc, args) {
      await claim(tc, args.record_id);
      return addLog(tc.ctx, tc.actor, tc.project.id, args.record_id, { body: args.body });
    },
  }),
  defineTool({
    name: 'research_snapshot',
    description:
      '把项目来源保存为不可变快照；complete保存本地原件，excerpt保存明确提供的文字，external仅表示远程链接。',
    roles: WORKER_ROLES,
    schema: z.object({ source_id: z.string(), input: ResearchSnapshotCreateInput }),
    async run(tc, args) {
      const source = await getEntity<ResearchSource>(
        tc.ctx,
        tc.project.id,
        'source',
        args.source_id,
      );
      await claim(tc, source.recordId ?? tc.project.id);
      return createSnapshot(tc.ctx, tc.actor, tc.project.id, args.source_id, args.input);
    },
  }),
  defineTool({
    name: 'research_excerpt',
    description: '从固定快照创建有定位和来源类型的原文摘录；无法服务端核对原文时标记unverified。',
    roles: WORKER_ROLES,
    schema: z.object({ record_id: z.string(), input: EvidenceExcerptCreateInput }),
    async run(tc, args) {
      await claim(tc, args.record_id);
      return createExcerpt(tc.ctx, tc.actor, tc.project.id, args.record_id, args.input);
    },
  }),
  defineTool({
    name: 'research_code',
    description: '建立或修改质性代码，或把摘录按主题代码和对象代号编码。',
    roles: WORKER_ROLES,
    schema: z.discriminatedUnion('op', [
      z.object({ op: z.literal('create'), record_id: z.string(), input: ResearchCodeCreateInput }),
      z.object({
        op: z.literal('update'),
        record_id: z.string(),
        code_id: z.string(),
        base_version: z.number().int().positive(),
        name: z.string().optional(),
        definition: z.string().optional(),
        group: z.string().nullable().optional(),
      }),
      z.object({
        op: z.literal('coding'),
        record_id: z.string(),
        input: ResearchCodingCreateInput,
      }),
    ]),
    async run(tc, args) {
      await claim(tc, args.record_id);
      if (args.op === 'create')
        return createCode(tc.ctx, tc.actor, tc.project.id, args.record_id, args.input);
      if (args.op === 'coding')
        return createCoding(tc.ctx, tc.actor, tc.project.id, args.record_id, args.input);
      const code = await getEntity<{ recordId: string }>(
        tc.ctx,
        tc.project.id,
        'code',
        args.code_id,
      );
      if (code.recordId !== args.record_id) throw new Error('代码不属于指定研究空间');
      return updateCode(tc.ctx, tc.actor, tc.project.id, args.code_id, {
        baseVersion: args.base_version,
        name: args.name,
        definition: args.definition,
        group: args.group,
      });
    },
  }),
  defineTool({
    name: 'research_finding',
    description: '创建或更新研究发现，分别列支持、反例、背景摘录与局限。AI不能自报人工确认。',
    roles: WORKER_ROLES,
    schema: z.discriminatedUnion('op', [
      z.object({
        op: z.literal('create'),
        record_id: z.string(),
        input: ResearchFindingCreateInput,
      }),
      z.object({
        op: z.literal('update'),
        record_id: z.string(),
        finding_id: z.string(),
        base_version: z.number().int().positive(),
        input: ResearchFindingUpdateInput.omit({ baseVersion: true }),
      }),
    ]),
    async run(tc, args) {
      await claim(tc, args.record_id);
      if (args.op === 'create')
        return createFinding(tc.ctx, tc.actor, tc.project.id, args.record_id, args.input);
      const finding = await getEntity<{ recordId: string }>(
        tc.ctx,
        tc.project.id,
        'finding',
        args.finding_id,
      );
      if (finding.recordId !== args.record_id) throw new Error('发现不属于指定研究空间');
      return updateFinding(tc.ctx, tc.actor, tc.project.id, args.finding_id, {
        ...args.input,
        baseVersion: args.base_version,
      });
    },
  }),
  defineTool({
    name: 'research_export',
    description:
      '导出研究空间、实际运行与完整依据，包括历史修订、来源快照、摘录、编码、发现；可用JSON、Markdown或CSV。',
    roles: ALL_ROLES,
    schema: z.object({
      record_id: z.string(),
      format: z.enum(['json', 'markdown', 'csv']).default('markdown'),
    }),
    async run(tc, args) {
      const result = await exportResearch(tc.ctx, tc.project.id, args.record_id, args.format);
      return { format: args.format, mime: result.mime, content: result.body };
    },
  }),
];
