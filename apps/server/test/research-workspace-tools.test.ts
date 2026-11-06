import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ActorRef,
  ResearchItem,
  ResearchRecord,
  ResearchRelation,
  ResearchRun,
} from '@srh/shared';
import { ALL_TOOLS } from '../src/agents/tools';
import { toolSpec, type ToolContext } from '../src/agents/tools/types';
import { agentSessions, projects, threads } from '../src/db/schema';
import { createClaim, releaseClaim } from '../src/modules/claims/service';
import { setExecutionRunners } from '../src/modules/research/execution-runners';
import { createMessage } from '../src/modules/timeline/service';
import { createProjectThread } from '../src/modules/threads/service';
import { makeApp, setupProject, type TestApp } from './helpers';

let t: TestApp;
let tc: ToolContext;
let actor: ActorRef;
let recordId: string;
const tool = ALL_TOOLS.find((entry) => entry.name === 'research_workspace')!;
const invoke = <T>(input: object) => tool.run(tc, tool.schema.parse(input)) as Promise<T>;

beforeAll(async () => {
  t = await makeApp();
  const { owner, project } = await setupProject(t.app, []);
  actor = { kind: 'user', id: owner.user.id, name: owner.user.name };
  const record = await owner.req('POST', `/projects/${project.id}/research/workspaces`, {
    title: '工具空间',
  });
  recordId = record.json<ResearchRecord>().id;
  const root = await createMessage(t.app.ctx, {
    projectId: project.id,
    threadId: null,
    author: actor,
    body: '整理研究资料',
  });
  const created = await createProjectThread(t.app.ctx, {
    projectId: project.id,
    rootMessageId: root.id,
    title: '资料整理',
    workingForUserId: owner.user.id,
    actor,
  });
  await t.db.db
    .update(agentSessions)
    .set({ model: 'chosen/model', effort: 'max', profile: 'chosen-profile' })
    .where(eq(agentSessions.id, created.sessionId));
  const [session] = await t.db.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, created.sessionId));
  const [row] = await t.db.db.select().from(projects).where(eq(projects.id, project.id));
  const [thread] = await t.db.db.select().from(threads).where(eq(threads.id, created.thread.id));
  tc = {
    ctx: t.app.ctx,
    session: session!,
    project: row!,
    thread: thread!,
    turnId: 'workspace_tool_test',
    actor: { kind: 'agent', id: created.sessionId, name: '研协' },
    requesterUserId: owner.user.id,
    visible: new Set(),
    setActivity: async () => {},
  };
  setExecutionRunners(t.app.ctx, {
    async selectModel(_ctx, _project, _user, requested) {
      return {
        model: requested.model!,
        effort: requested.effort!,
        profile: requested.profile,
        profilePrompt: 'profile 内容',
      };
    },
    async checkNotebook() {},
    async ai() {
      return {
        outputs: [
          { title: '草稿', content: '这是真实测试模型生成的研究草稿。', origin: 'ai_draft' },
        ],
        logs: [],
      };
    },
    async notebook() {
      throw new Error('不应运行 Notebook');
    },
  });
}, 60000);
afterAll(async () => {
  await t.close();
}, 60000);

describe('研究空间 agent 工具', () => {
  it('参数顶层是 object；只读可用，写入和运行共用认领守卫', async () => {
    expect(toolSpec(tool).parameters.type).toBe('object');
    expect(toolSpec(tool).parameters).not.toHaveProperty('anyOf');
    expect(tool.schema.safeParse({ op: 'confirm', record_id: recordId }).success).toBe(false);
    await expect(
      invoke({ op: 'workspace_create', input: { title: '新研究' } }),
    ).rejects.toMatchObject({ details: { code: 'claim_required' } });
    const newClaim = await createClaim(t.app.ctx, tc.actor, tc.project.id, {
      resourceKind: 'research',
      resourceRef: 'new',
      mode: 'exclusive',
      intent: '建立研究',
      ttlSec: 1800,
    });
    const space = await invoke<ResearchRecord>({
      op: 'workspace_create',
      input: { title: '新研究' },
    });
    expect(space.title).toBe('新研究');
    await releaseClaim(t.app.ctx, tc.actor, tc.project.id, newClaim.id);
    const read = await invoke<{ items: { items: unknown[] } }>({ op: 'list', record_id: recordId });
    expect(read.items.items).toEqual([]);
    await expect(
      invoke({
        op: 'create',
        record_id: recordId,
        input: { kind: 'note', title: '材料', body: '正文' },
      }),
    ).rejects.toMatchObject({ details: { code: 'claim_required' } });
    const foreign = await createClaim(
      t.app.ctx,
      { kind: 'agent', id: 'agent_other', name: '另一线程' },
      tc.project.id,
      {
        resourceKind: 'research',
        resourceRef: recordId,
        mode: 'exclusive',
        intent: '其他工作',
        ttlSec: 1800,
      },
    );
    await expect(
      invoke({
        op: 'create',
        record_id: recordId,
        input: { kind: 'note', title: '材料', body: '正文' },
      }),
    ).rejects.toMatchObject({ details: { code: 'claim_conflict' } });
    await releaseClaim(
      t.app.ctx,
      { kind: 'agent', id: 'agent_other', name: '另一线程' },
      tc.project.id,
      foreign.id,
    );
    const own = await createClaim(t.app.ctx, tc.actor, tc.project.id, {
      resourceKind: 'research',
      resourceRef: recordId,
      mode: 'exclusive',
      intent: '整理材料',
      ttlSec: 1800,
    });
    const item = await invoke<ResearchItem>({
      op: 'create',
      record_id: recordId,
      input: {
        kind: 'action',
        title: '生成草稿',
        action: { kind: 'ai', instructions: '起草说明' },
      },
    });
    const note = await invoke<ResearchItem>({
      op: 'create',
      record_id: recordId,
      input: { kind: 'note', title: '材料', body: '完整正文' },
    });
    const first = await invoke<{ items: { items: ResearchItem[]; nextCursor: string | null } }>({
      op: 'list',
      record_id: recordId,
      limit: 1,
    });
    expect(first.items.items).toHaveLength(1);
    expect(first.items.nextCursor).toBeTruthy();
    const second = await invoke<{ items: { items: ResearchItem[] } }>({
      op: 'list',
      record_id: recordId,
      limit: 1,
      cursor: first.items.nextCursor,
    });
    expect(second.items.items[0]?.id).not.toBe(first.items.items[0]?.id);
    const moved = await invoke<ResearchItem>({
      op: 'move',
      record_id: recordId,
      item_id: note.id,
      input: { basePositionVersion: note.positionVersion, position: { x: 12, y: 15 } },
    });
    expect(moved.position).toEqual({ x: 12, y: 15 });
    const batch = await invoke<{ items: ResearchItem[] }>({
      op: 'layout',
      record_id: recordId,
      input: {
        moves: [
          {
            itemId: note.id,
            basePositionVersion: moved.positionVersion,
            position: { x: 20, y: 30 },
          },
        ],
        idempotencyKey: 'tool_layout_01',
      },
    });
    expect(batch.items[0]?.position).toEqual({ x: 20, y: 30 });
    const table = await invoke<ResearchItem>({
      op: 'create',
      record_id: recordId,
      input: {
        kind: 'table',
        title: '完整表格',
        table: {
          columns: [
            { id: 'name', name: '类别' },
            { id: 'value', name: '值', type: 'number' },
          ],
          rows: [
            ['甲', 1],
            ['乙', 2],
          ],
        },
      },
    });
    const tablePage = await invoke<{
      rows: { cells: Record<string, unknown> }[];
      nextCursor: string | null;
    }>({ op: 'table', record_id: recordId, item_id: table.id, limit: 1 });
    expect(tablePage.rows).toHaveLength(1);
    expect(tablePage.nextCursor).not.toBeNull();
    expect(
      (
        await invoke<{ rows: unknown[] }>({
          op: 'table',
          record_id: recordId,
          item_id: table.id,
          limit: 1,
          cursor: tablePage.nextCursor,
        })
      ).rows,
    ).toHaveLength(1);
    expect(await invoke({ op: 'artifacts', record_id: recordId, item_id: table.id })).toMatchObject(
      { items: [] },
    );
    await expect(
      invoke({ op: 'artifact_read', record_id: recordId, artifact_id: 'rart_missing' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const relation = await invoke<ResearchRelation>({
      op: 'relation_create',
      record_id: recordId,
      input: { fromItemId: note.id, toItemId: item.id, label: '参考' },
    });
    const updated = await invoke<ResearchRelation>({
      op: 'relation_update',
      record_id: recordId,
      relation_id: relation.id,
      input: { baseVersion: relation.version, label: '依据' },
    });
    const relations = await invoke<{ items: ResearchRelation[] }>({
      op: 'relations',
      record_id: recordId,
    });
    expect(relations.items[0]?.label).toBe('依据');
    await invoke({
      op: 'relation_archive',
      record_id: recordId,
      relation_id: relation.id,
      base_version: updated.version,
    });
    expect(
      (await invoke<{ items: ResearchRelation[] }>({ op: 'relations', record_id: recordId })).items,
    ).toEqual([]);
    const run = await invoke<ResearchRun>({
      op: 'start',
      record_id: recordId,
      input: { steps: [{ itemId: item.id }], idempotencyKey: 'tool_start_01' },
    });
    expect(run.settings).toEqual({
      model: 'chosen/model',
      effort: 'max',
      profile: 'chosen-profile',
    });
    expect(run.steps[0]?.selection).toMatchObject(run.settings);
    await releaseClaim(t.app.ctx, tc.actor, tc.project.id, own.id);
  });
});
