import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ActorRef,
  EvidenceExcerpt,
  ResearchCode,
  ResearchCoding,
  ResearchFinding,
  ResearchLog,
  ResearchRecord,
  ResearchSnapshot,
  ResearchSource,
  ResearchTemplate,
} from '@srh/shared';
import { ALL_TOOLS, toolsFor } from '../src/agents/tools';
import type { ToolContext } from '../src/agents/tools/types';
import { agentSessions, projects, threads } from '../src/db/schema';
import { createClaim, releaseClaim } from '../src/modules/claims/service';
import { writeProjectFile } from '../src/modules/files/service';
import { createMessage } from '../src/modules/timeline/service';
import { createProjectThread } from '../src/modules/threads/service';
import { makeApp, setupProject, type TestApp } from './helpers';

const RESEARCH_TOOLS = [
  'research_list',
  'research_read',
  'research_create',
  'research_update',
  'research_log',
  'research_snapshot',
  'research_excerpt',
  'research_code',
  'research_finding',
  'research_export',
] as const;

let t: TestApp;
let tc: ToolContext;
let member: ActorRef;

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const tool = toolsFor(tc.ctx, tc.session.role).find((item) => item.name === name);
  if (!tool) throw new Error(`工具未注册：${name}`);
  return tool.run(tc, tool.schema.parse(args)) as Promise<T>;
}

async function expectToolError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    details: { code },
  });
}

beforeAll(async () => {
  t = await makeApp(); // LLM_API_KEY 未配置，工具直接调用，不启动模型。
  const { project, owner } = await setupProject(t.app, []);
  member = { kind: 'user', id: owner.user.id, name: owner.user.name };
  const root = await createMessage(t.app.ctx, {
    projectId: project.id,
    threadId: null,
    author: member,
    body: '整理研究材料并保留证据链',
  });
  const { thread, sessionId } = await createProjectThread(t.app.ctx, {
    projectId: project.id,
    rootMessageId: root.id,
    title: '研究证据链',
    workingForUserId: owner.user.id,
    actor: member,
  });
  const [sessionRow] = await t.db.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId));
  const [projectRow] = await t.db.db.select().from(projects).where(eq(projects.id, project.id));
  const [threadRow] = await t.db.db.select().from(threads).where(eq(threads.id, thread.id));
  tc = {
    ctx: t.app.ctx,
    session: sessionRow!,
    project: projectRow!,
    thread: threadRow!,
    turnId: 'turn_research_tools',
    actor: { kind: 'agent', id: sessionId, name: '研协' },
    requesterUserId: owner.user.id,
    visible: new Set(),
    setActivity: async () => {},
  };
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('agent 科研工具真实闭环', () => {
  it('十个研究工具可用且原有实验和 Notebook 工具继续注册', () => {
    const names = toolsFor(tc.ctx, 'thread').map((tool) => tool.name);
    for (const name of RESEARCH_TOOLS) expect(names).toContain(name);
    for (const name of ['list_notebooks', 'read_notebook', 'edit_notebook'])
      expect(names).toContain(name);
    // Python 内核未配置时执行工具会隐藏，但旧定义仍保留在注册表。
    expect(ALL_TOOLS.map((tool) => tool.name)).toContain('run_notebook_cells');
    const coordinator = toolsFor(tc.ctx, 'coordinator').map((tool) => tool.name);
    expect(coordinator).toContain('research_read');
    expect(coordinator).toContain('research_export');
    expect(coordinator).not.toContain('research_update');
  });

  it('从先认领到导出保留 AI 归属、支持证据与冲突边界', async () => {
    const templates = await call<{ items: ResearchTemplate[] }>('research_list', {
      kind: 'templates',
    });
    expect(templates.items.some((template) => template.id === 'rtpl_preset_general')).toBe(true);

    await expectToolError(
      call('research_create', {
        kind: 'record',
        input: { templateId: 'rtpl_preset_general', title: '证据链' },
      }),
      'claim_required',
    );
    const newClaim = await call<{ ok: boolean; claim_id: string }>('claim', {
      resource_kind: 'research',
      resource_ref: 'new',
      intent: '建立研究记录',
    });
    expect(newClaim.ok).toBe(true);
    expect(newClaim.claim_id).toBeTruthy();
    const record = await call<ResearchRecord>('research_create', {
      kind: 'record',
      input: { templateId: 'rtpl_preset_general', title: '证据链' },
    });
    expect(record.createdBy.kind).toBe('agent');

    const other: ActorRef = { kind: 'agent', id: 'agt_research_other', name: '另一线程' };
    const foreign = await createClaim(tc.ctx, other, tc.project.id, {
      resourceKind: 'research',
      resourceRef: record.id,
      mode: 'exclusive',
      intent: '核对同一记录',
      ttlSec: 1800,
    });
    await expectToolError(
      call('research_update', {
        record_id: record.id,
        change: { baseVersion: record.version, title: '不应改写' },
      }),
      'claim_conflict',
    );
    await releaseClaim(tc.ctx, other, tc.project.id, foreign.id);
    await call<{ ok: boolean; claim_id: string }>('claim', {
      resource_kind: 'research',
      resource_ref: record.id,
      intent: '整理记录和来源',
    });

    const { file } = await writeProjectFile(
      tc.ctx,
      member,
      tc.project.id,
      'research-tools-evidence.txt',
      '原文证据来自项目文件。',
    );
    const source = await call<ResearchSource>('research_create', {
      kind: 'source',
      input: {
        recordId: record.id,
        kind: 'file',
        resourceId: file.id,
        title: '项目原件',
      },
    });
    const detail = await call<{ record: ResearchRecord; sources: ResearchSource[] }>(
      'research_read',
      { record_id: record.id },
    );
    expect(detail.record.sourceIds).toContain(source.id);
    expect(detail.sources.map((item) => item.id)).toContain(source.id);

    const updated = await call<ResearchRecord>('research_update', {
      record_id: record.id,
      change: { baseVersion: detail.record.version, stepState: { step_general_1: true } },
    });
    expect(updated.stepReports.step_general_1).toMatchObject({
      done: true,
      origin: 'agent_work',
      verification: 'unverified',
    });
    const log = await call<ResearchLog>('research_log', {
      record_id: record.id,
      body: '已整理项目原件，实体采集由成员完成。',
    });
    expect(log.createdBy.kind).toBe('agent');

    const snapshot = await call<ResearchSnapshot>('research_snapshot', {
      source_id: source.id,
      input: { coverage: 'complete' },
    });
    expect(snapshot.coverage).toBe('complete');
    await expect(
      call('research_excerpt', {
        record_id: record.id,
        input: {
          sourceId: source.id,
          snapshotId: snapshot.id,
          quote: '原文证据',
          locator: { kind: 'text', paragraph: 1 },
          origin: 'observation',
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const excerpt = await call<EvidenceExcerpt>('research_excerpt', {
      record_id: record.id,
      input: {
        sourceId: source.id,
        snapshotId: snapshot.id,
        quote: '原文证据',
        locator: { kind: 'text', paragraph: 1 },
        origin: 'ai_extraction',
      },
    });
    expect(excerpt.origin).toBe('ai_extraction');
    expect(excerpt.verification).toBe('verified');

    const code = await call<ResearchCode>('research_code', {
      op: 'create',
      record_id: record.id,
      input: { name: '证据主题', definition: '与问题直接相关的原文' },
    });
    const coding = await call<ResearchCoding>('research_code', {
      op: 'coding',
      record_id: record.id,
      input: { excerptId: excerpt.id, codeId: code.id },
    });
    expect(coding.codeId).toBe(code.id);
    await expect(
      call('research_finding', {
        op: 'create',
        record_id: record.id,
        input: {
          statement: '原件支持命题',
          supportingExcerptIds: [excerpt.id],
          humanConfirmed: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const finding = await call<ResearchFinding>('research_finding', {
      op: 'create',
      record_id: record.id,
      input: { statement: '原件支持命题', supportingExcerptIds: [excerpt.id] },
    });
    expect(finding.humanConfirmed).toBe(false);
    const revised = await call<ResearchFinding>('research_finding', {
      op: 'update',
      record_id: record.id,
      finding_id: finding.id,
      base_version: finding.version,
      input: { limitations: '尚待成员复核' },
    });
    expect(revised.supportingExcerptIds).toEqual([excerpt.id]);
    expect(revised.limitations).toBe('尚待成员复核');

    const exported = await call<{ format: string; content: string }>('research_export', {
      record_id: record.id,
      format: 'json',
    });
    const provenance = JSON.parse(exported.content) as {
      record: ResearchRecord;
      sources: ResearchSource[];
      snapshots: ResearchSnapshot[];
      excerpts: EvidenceExcerpt[];
      codings: ResearchCoding[];
      findings: ResearchFinding[];
    };
    expect(provenance.record.id).toBe(record.id);
    expect(provenance.sources.map((item) => item.id)).toContain(source.id);
    expect(provenance.snapshots.map((item) => item.id)).toContain(snapshot.id);
    expect(provenance.excerpts.map((item) => item.id)).toContain(excerpt.id);
    expect(provenance.codings.map((item) => item.id)).toContain(coding.id);
    expect(provenance.findings[0]?.supportingExcerptIds).toEqual([excerpt.id]);
    expect(
      (await call<{ items: ResearchRecord[] }>('research_list', { kind: 'records' })).items,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: record.id })]));
  });
});
