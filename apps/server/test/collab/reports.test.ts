import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentMeta, Report, Todo } from '@srh/shared';
import type { LlmClient } from '../../src/agents/llm/client';
import { collab } from '../../src/agents/tools/collab-port';
import {
  documents,
  memoryFiles,
  messages,
  reviewComments,
  reviewParticipants,
  reviews,
  threads,
  todos,
} from '../../src/db/schema';
import { setLlmClientForTest } from '../../src/modules/collab-common/llm';
import {
  collectReportContext,
  extractPlanItems,
  resolvePromptPath,
  waitForReportJobs,
} from '../../src/modules/reports';
import { setupCollabApp, type CollabTestApp } from './helpers';

const P = 'prj_rpt';
const BASE = `/api/v1/projects/${P}/reports`;
const OWNER = 'usr_owner';
const MEMBER = 'usr_member';
const GUEST = 'usr_guest';
const STRANGER = 'usr_stranger';

const IN = new Date('2026-10-22T10:00:00+08:00');
const IN_LATER = new Date('2026-10-23T15:30:00+08:00');
const OUT = new Date('2026-10-01T10:00:00+08:00');
const PERIOD = { periodStart: '2026-10-19', periodEnd: '2026-10-25' };
const actor = (name: string) => ({ kind: 'user' as const, id: OWNER, name });

const REPORT_MD = [
  '# 测试课题 组会汇报（2026-10-19 至 2026-10-25）',
  '',
  '## 本期进展',
  '',
  '- 基线复现完成，[对比学习基线复现](#thr_in)',
  '',
  '## 下期计划',
  '',
  '- @张三：完成 [exp-08 消融](#exp_x)（来源：[线程](#thr_in)）',
  '- **李四** 整理综述',
].join('\n');

// ---------------------------------------------------------------- 假 LLM

interface Call {
  model: string;
  messages: { role: string; content: string }[];
}
let calls: Call[] = [];
let mode: 'ok' | 'fenced' | 'error' | 'hang' = 'ok';
let release: (() => void) | null = null;

const fake: LlmClient = {
  model: 'chat-model',
  reasoningModel: 'reasoning-model',
  client: {
    chat: {
      completions: {
        async create(body: Call) {
          calls.push(body);
          if (mode === 'error') throw Object.assign(new Error('too many'), { status: 429 });
          if (mode === 'hang') await new Promise<void>((r) => (release = r));
          const content = mode === 'fenced' ? `\`\`\`markdown\n${REPORT_MD}\n\`\`\`` : REPORT_MD;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  } as unknown as LlmClient['client'],
};

// ---------------------------------------------------------------- 脚手架

let t: CollabTestApp;

async function seed() {
  const db = t.db.db;
  const msg = (
    id: string,
    body: string,
    extra: Partial<typeof messages.$inferInsert> = {},
  ): typeof messages.$inferInsert => ({
    id,
    projectId: P,
    authorKind: 'user',
    authorId: OWNER,
    authorName: '张三',
    body,
    createdAt: IN,
    ...extra,
  });

  await db.insert(threads).values([
    {
      id: 'thr_in',
      projectId: P,
      rootMessageId: 'msg_root_in',
      title: '对比学习基线复现',
      label: '实验',
      statusBucket: 'working',
      statusText: '复现基线\n✓ 数据预处理\n✱ 跑 3 个 seed\n○ 写对比表',
      ownerUserId: OWNER,
      createdAt: IN,
      lastActivityAt: IN_LATER,
    },
    {
      id: 'thr_old',
      projectId: P,
      rootMessageId: 'msg_root_old',
      title: '旧线程不该出现',
      createdAt: OUT,
      lastActivityAt: OUT,
    },
    {
      id: 'thr_personal',
      projectId: P,
      kind: 'personal',
      rootMessageId: 'msg_root_personal',
      title: '私人会话标题',
      ownerUserId: OWNER,
      createdAt: IN,
      lastActivityAt: IN,
    },
  ]);
  await db.insert(messages).values([
    msg('msg_in', '基线 top-1 达到 76.5%，下一步做学习率扫描'),
    msg('msg_thread', '已完成数据预处理', {
      threadId: 'thr_in',
      authorKind: 'agent',
      authorId: 'agt_x',
      authorName: '线程 agent',
      createdAt: IN_LATER,
    }),
    msg('msg_side', '旁聊秘密内容', { agentVisible: false }),
    msg('msg_personal', '个人工作区私话', { threadId: 'thr_personal' }),
    msg('msg_old', '十月初的旧消息', { createdAt: OUT }),
    msg('msg_deleted', '已删除的消息', { deletedAt: IN_LATER }),
  ]);
  await db.insert(reviews).values({
    id: 'rev_in',
    projectId: P,
    targetKind: 'document',
    targetId: 'doc_in',
    title: '方法章节审阅',
    requestedBy: actor('张三'),
    createdAt: IN,
    updatedAt: IN,
  });
  await db
    .insert(reviewParticipants)
    .values({ reviewId: 'rev_in', userId: MEMBER, verdict: 'lgtm' });
  await db.insert(reviewComments).values({
    id: 'rvc_in',
    reviewId: 'rev_in',
    author: { kind: 'user', id: MEMBER, name: '李四' },
    body: '公式 3 的符号需要统一',
    createdAt: IN,
  });
  await db.insert(todos).values([
    {
      id: 'tdo_in',
      projectId: P,
      title: '整理消融实验表',
      position: 'a0',
      createdBy: actor('张三'),
      createdAt: IN,
    },
    {
      id: 'tdo_old',
      projectId: P,
      title: '很久以前的待办',
      position: 'a1',
      createdBy: actor('张三'),
      createdAt: OUT,
    },
  ]);
  await db.insert(documents).values([
    {
      id: 'doc_in',
      projectId: P,
      title: '文献综述',
      contentText: '综述正文：对比学习方法分三类',
      createdBy: actor('张三'),
      createdAt: IN,
      updatedAt: IN,
    },
    {
      id: 'doc_archived',
      projectId: P,
      title: '已归档文档',
      createdBy: actor('张三'),
      updatedAt: IN,
      archivedAt: IN_LATER,
    },
  ]);
  await db.insert(memoryFiles).values({
    id: 'mem_index',
    projectId: P,
    path: 'MEMORY.md',
    content: '项目记忆：数据集固定用 CIFAR-100',
    updatedBy: actor('张三'),
  });
}

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser(OWNER, '张三', 0);
  await t.seedUser(MEMBER, '李四', 1);
  await t.seedUser(GUEST, '王五', 2);
  await t.seedUser(STRANGER, '路人', 3);
  await t.seedProject(P, OWNER);
  await t.addMember(P, MEMBER, 'member');
  await t.addMember(P, GUEST, 'guest');
  await seed();
}, 60_000);

afterAll(async () => {
  await waitForReportJobs();
  await t?.close();
});

beforeEach(() => {
  calls = [];
  mode = 'ok';
  release = null;
  setLlmClientForTest(t.app.ctx, fake);
});

async function create(body: Record<string, unknown> = {}, user = OWNER) {
  return t.app.inject({
    method: 'POST',
    url: BASE,
    headers: t.as(user),
    payload: { ...PERIOD, ...body },
  });
}

async function get(id: string, user = OWNER): Promise<Report> {
  const res = await t.app.inject({ method: 'GET', url: `${BASE}/${id}`, headers: t.as(user) });
  expect(res.statusCode).toBe(200);
  return res.json<Report>();
}

async function reportEvents(id: string) {
  const events = await t.app.ctx.bus.listSince(P, 0, 5000);
  return events.filter(
    (e) => e.type.startsWith('report.') && (e.payload as { id?: string }).id === id,
  );
}

// ---------------------------------------------------------------- 测试

describe('collectReportContext', () => {
  it('只收期内、agent 可见、项目线程里的记录', async () => {
    const ctx = await collectReportContext(
      t.app.ctx,
      P,
      new Date('2026-10-19T00:00:00+08:00'),
      new Date('2026-10-25T23:59:59.999+08:00'),
    );
    for (const s of [
      '测试课题',
      '对比学习基线复现',
      '✱ 跑 3 个 seed',
      '基线 top-1 达到 76.5%',
      '已完成数据预处理',
      '线程 agent（agent）',
      '方法章节审阅',
      '李四：LGTM',
      '公式 3 的符号需要统一',
      '整理消融实验表',
      '文献综述',
      '对比学习方法分三类',
      'CIFAR-100',
      '#thr_in',
    ]) {
      expect(ctx.text, s).toContain(s);
    }
    for (const s of [
      '旧线程不该出现',
      '私人会话标题',
      '旁聊秘密内容',
      '个人工作区私话',
      '十月初的旧消息',
      '已删除的消息',
      '学习率扫描 exp-07',
      'top1=78.4%',
      'seed=1 跑完',
      '去年的实验',
      '旧日志不该出现',
      '很久以前的待办',
      '已归档文档',
    ]) {
      expect(ctx.text, s).not.toContain(s);
    }
    expect(ctx.stats).toEqual({
      threads: 1,
      messages: 2,
      experiments: 0,
      researchRecords: 0,
      reviews: 1,
      todos: 1,
      documents: 1,
    });
    expect(ctx.text.length).toBeLessThan(60_000);
  });
});

describe('生成汇报', () => {
  it('POST generate=true：201 generating → 后台生成 → draft，带 content 与 stats', async () => {
    const res = await create({ instructions: '重点讲学习率扫描' });
    expect(res.statusCode).toBe(201);
    const created = res.json<Report>();
    expect(created.status).toBe('generating');
    expect(created.title).toBe('组会汇报 · 10月19日–10月25日');
    expect(created.periodStart).toBe('2026-10-18T16:00:00.000Z');
    expect(created.periodEnd).toBe('2026-10-25T15:59:59.999Z');

    await waitForReportJobs();
    const done = await get(created.id);
    expect(done.status).toBe('draft');
    expect(done.content).toBe(REPORT_MD);
    expect(done.error).toBeNull();
    expect(done.stats).toMatchObject({ threads: 1, experiments: 0, reviews: 1 });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.model).toBe('reasoning-model');
    const system = call.messages.find((m) => m.role === 'system')!.content;
    const user = call.messages.find((m) => m.role === 'user')!.content;
    expect(system).toContain('「测试课题」的组会汇报草稿');
    expect(system).toContain('2026-10-19 至 2026-10-25');
    expect(system).toContain('重点讲学习率扫描');
    expect(system).not.toMatch(/\{\{\w+\}\}/u);
    expect(system).not.toContain('<!--');
    expect(user).not.toContain('学习率扫描 exp-07');
    expect(user).toContain('对比学习基线复现');
    expect(user).toContain('方法章节审阅');
    expect(user).not.toContain('去年的实验');
    expect(user).not.toContain('旁聊秘密内容');

    const events = await reportEvents(created.id);
    expect(events.map((e) => e.type)).toEqual(['report.created', 'report.updated']);
    expect((events[1]!.payload as Report).status).toBe('draft');
  });

  it('去掉模型输出外面的 ``` 围栏', async () => {
    mode = 'fenced';
    const created = (await create()).json<Report>();
    await waitForReportJobs();
    expect((await get(created.id)).content).toBe(REPORT_MD);
  });

  it('LLM 报错：回到 draft，error 为中文原因，保留旧正文', async () => {
    const created = (await create()).json<Report>();
    await waitForReportJobs();
    mode = 'error';
    const res = await t.app.inject({
      method: 'POST',
      url: `${BASE}/${created.id}/regenerate`,
      headers: t.as(MEMBER),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Report>().status).toBe('generating');
    await waitForReportJobs();
    const after = await get(created.id);
    expect(after.status).toBe('draft');
    expect(after.error).toBe('大模型调用太频繁了，请稍等片刻再试');
    expect(after.content).toBe(REPORT_MD);
  });

  it('未配置 API Key：201 + draft + error，不报 503', async () => {
    setLlmClientForTest(t.app.ctx, null);
    const res = await create();
    expect(res.statusCode).toBe(201);
    const report = res.json<Report>();
    expect(report.status).toBe('draft');
    expect(report.error).toMatch(/^还没有配置大模型 API Key/u);
    await waitForReportJobs();
    expect(calls).toHaveLength(0);

    const regen = await t.app.inject({
      method: 'POST',
      url: `${BASE}/${report.id}/regenerate`,
      headers: t.as(OWNER),
    });
    expect(regen.statusCode).toBe(200);
    expect(regen.json<Report>()).toMatchObject({ status: 'draft' });
    expect(regen.json<Report>().error).toMatch(/^还没有配置大模型 API Key/u);
  });

  it('regenerate 带额外要求', async () => {
    const created = (await create({ generate: false })).json<Report>();
    const res = await t.app.inject({
      method: 'POST',
      url: `${BASE}/${created.id}/regenerate`,
      headers: t.as(OWNER),
      payload: { instructions: '给导师看，突出风险' },
    });
    expect(res.json<Report>().status).toBe('generating');
    await waitForReportJobs();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[1]!.content).toContain('给导师看，突出风险');
    const after = await get(created.id);
    expect(after).toMatchObject({ status: 'draft', content: REPORT_MD, error: null });
  });

  it('生成中：PATCH 正文 409，改标题可以，重复 regenerate 409', async () => {
    mode = 'hang';
    const created = (await create()).json<Report>();
    // 等假 LLM 被调用（上下文收集完）
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    expect(release).not.toBeNull();

    const patch = await t.app.inject({
      method: 'PATCH',
      url: `${BASE}/${created.id}`,
      headers: t.as(OWNER),
      payload: { content: '手改' },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json()).toMatchObject({
      error: { code: 'conflict', message: '正在生成，稍后再改' },
    });

    const title = await t.app.inject({
      method: 'PATCH',
      url: `${BASE}/${created.id}`,
      headers: t.as(OWNER),
      payload: { title: '第 8 周组会' },
    });
    expect(title.statusCode).toBe(200);
    expect(title.json<Report>()).toMatchObject({ title: '第 8 周组会', status: 'generating' });

    const regen = await t.app.inject({
      method: 'POST',
      url: `${BASE}/${created.id}/regenerate`,
      headers: t.as(OWNER),
    });
    expect(regen.statusCode).toBe(409);

    release!();
    await waitForReportJobs();
    expect(await get(created.id)).toMatchObject({
      status: 'draft',
      title: '第 8 周组会',
      content: REPORT_MD,
    });
  });
});

describe('增删改查', () => {
  it('generate=false 直接建空稿；列表新到旧', async () => {
    const a = (await create({ generate: false, title: '第一份' })).json<Report>();
    const b = (await create({ generate: false, title: '第二份' })).json<Report>();
    expect(a).toMatchObject({ status: 'draft', content: '', error: null, stats: null });
    expect(calls).toHaveLength(0);

    const list = await t.app.inject({ method: 'GET', url: BASE, headers: t.as(GUEST) });
    expect(list.statusCode).toBe(200);
    const ids = list.json<Report[]>().map((r) => r.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it('开始晚于结束 → 422', async () => {
    const res = await create({ periodStart: '2026-10-26', periodEnd: '2026-10-20' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('PATCH 与 DELETE', async () => {
    const r = (await create({ generate: false })).json<Report>();
    const res = await t.app.inject({
      method: 'PATCH',
      url: `${BASE}/${r.id}`,
      headers: t.as(MEMBER),
      payload: { title: '定稿', content: '# 正文', status: 'final' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Report>()).toMatchObject({ title: '定稿', content: '# 正文', status: 'final' });

    const bad = await t.app.inject({
      method: 'PATCH',
      url: `${BASE}/${r.id}`,
      headers: t.as(MEMBER),
      payload: { status: 'generating' },
    });
    expect(bad.statusCode).toBe(422);

    const del = await t.app.inject({
      method: 'DELETE',
      url: `${BASE}/${r.id}`,
      headers: t.as(MEMBER),
    });
    expect(del.statusCode).toBe(204);
    const gone = await t.app.inject({
      method: 'GET',
      url: `${BASE}/${r.id}`,
      headers: t.as(OWNER),
    });
    expect(gone.statusCode).toBe(404);
    expect((await reportEvents(r.id)).map((e) => e.type)).toEqual([
      'report.created',
      'report.updated',
      'report.deleted',
    ]);
  });

  it('PATCH 带 baseVersion：乐观并发，过期 → 409 version_conflict 带最新对象；不带照旧可写', async () => {
    const r = (await create({ generate: false })).json<Report>();
    expect(r.version).toBe(1);
    const patch = (user: string, payload: Record<string, unknown>) =>
      t.app.inject({ method: 'PATCH', url: `${BASE}/${r.id}`, headers: t.as(user), payload });

    const a = await patch(OWNER, { content: '导师的版本', baseVersion: 1 });
    expect(a.statusCode).toBe(200);
    expect(a.json<Report>()).toMatchObject({ content: '导师的版本', version: 2 });

    // 成员基于版本 1 的修改：不覆盖，返回最新对象
    const b = await patch(MEMBER, { content: '成员的版本', baseVersion: 1 });
    expect(b.statusCode).toBe(409);
    expect(b.json()).toMatchObject({
      error: {
        code: 'version_conflict',
        details: { current: { id: r.id, content: '导师的版本', version: 2 } },
      },
    });
    expect((await get(r.id)).content).toBe('导师的版本');

    // 同时发出两次基于同一版本的修改：只有一次成功
    const [x, y] = await Promise.all([
      patch(OWNER, { content: 'X', baseVersion: 2 }),
      patch(MEMBER, { content: 'Y', baseVersion: 2 }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect((await get(r.id)).version).toBe(3);

    // 不带 baseVersion（旧调用 / agent）照旧可写，版本照样递增
    const legacy = await patch(MEMBER, { title: '改个标题' });
    expect(legacy.json<Report>()).toMatchObject({ title: '改个标题', version: 4 });
  });

  it('权限：非成员 404，访客能看不能写', async () => {
    const r = (await create({ generate: false })).json<Report>();
    const stranger = await t.app.inject({ method: 'GET', url: BASE, headers: t.as(STRANGER) });
    expect(stranger.statusCode).toBe(404);
    const strangerOne = await t.app.inject({
      method: 'GET',
      url: `${BASE}/${r.id}`,
      headers: t.as(STRANGER),
    });
    expect(strangerOne.statusCode).toBe(404);

    expect((await get(r.id, GUEST)).id).toBe(r.id);
    expect((await create({}, GUEST)).statusCode).toBe(403);
    for (const [method, url] of [
      ['PATCH', `${BASE}/${r.id}`],
      ['DELETE', `${BASE}/${r.id}`],
      ['POST', `${BASE}/${r.id}/regenerate`],
      ['POST', `${BASE}/${r.id}/document`],
      ['POST', `${BASE}/${r.id}/todos`],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: t.as(GUEST), payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const anon = await t.app.inject({ method: 'GET', url: BASE });
    expect(anon.statusCode).toBe(401);
  });

  it('agent 端口 reports.draft：创建并后台生成', async () => {
    const port = collab('reports');
    expect(port).toBeDefined();
    const agentActor = { kind: 'agent' as const, id: 'agt_coord', name: '协调者' };
    const report = await port!.draft(t.app.ctx, agentActor, P, PERIOD);
    expect(report.status).toBe('generating');
    expect(report.createdBy).toEqual(agentActor);
    await waitForReportJobs();
    expect((await get(report.id)).status).toBe('draft');
  });
});

describe('下期计划', () => {
  it('extractPlanItems 抽出列表项，去掉标记、@某人 与来源注记', () => {
    const md = [
      '# 汇报',
      '## 本期进展',
      '- 不该被抽出',
      '## 下期计划',
      '',
      '- @张三：完成 [exp-08 消融](#exp_x)（来源：[线程](#thr_in)）',
      '- **李四** 整理 `related work` 综述',
      '  - 子项：补 3 篇 *2025* 年的论文',
      '1. @王五 @李四 复现 baseline',
      '- [ ] 写实验表',
      '- @张三：完成 [exp-08 消融](#exp_x)',
      '```',
      '- 代码块里的不算',
      '```',
      '### 小节内的子标题',
      '- 子标题下的也算',
      '## 附录',
      '- 不该被抽出',
    ].join('\n');
    expect(extractPlanItems(md)).toEqual([
      '完成 exp-08 消融',
      '李四 整理 related work 综述',
      '子项：补 3 篇 2025 年的论文',
      '复现 baseline',
      '写实验表',
      '子标题下的也算',
    ]);
  });

  it('去掉「负责人X」「由X负责」与「来源为…」注记（真实汇报的写法）', () => {
    const md = [
      '## 下周计划',
      '- ProtoNet 基线换 ResNet-12：负责人小模，来源为实验记录结论。[实验记录](#exp_01M5W3X)',
      '- 补 5-shot 结果（负责人：王导）',
      '- 由李四负责，复核消融结果',
    ].join('\n');
    expect(extractPlanItems(md)).toEqual([
      'ProtoNet 基线换 ResNet-12',
      '补 5-shot 结果',
      '复核消融结果',
    ]);
  });

  it('认 下周计划 / Next steps / 带编号的标题；没有计划小节返回空', () => {
    expect(extractPlanItems('## 下周计划\n- A\n- B')).toEqual(['A', 'B']);
    expect(extractPlanItems('## Next Steps\n* run ablation\n## Risks\n- x')).toEqual([
      'run ablation',
    ]);
    expect(extractPlanItems('## 五、下期计划\n- 甲')).toEqual(['甲']);
    expect(extractPlanItems('## 本期进展\n- A')).toEqual([]);
  });

  it('GET plan-items 与 POST todos（source = report）', async () => {
    const created = (await create()).json<Report>();
    await waitForReportJobs();
    const plan = await t.app.inject({
      method: 'GET',
      url: `${BASE}/${created.id}/plan-items`,
      headers: t.as(GUEST),
    });
    expect(plan.json()).toEqual({ items: ['完成 exp-08 消融', '李四 整理综述'] });

    const res = await t.app.inject({
      method: 'POST',
      url: `${BASE}/${created.id}/todos`,
      headers: t.as(OWNER),
      payload: {
        items: [{ title: '完成 exp-08 消融', assigneeId: MEMBER }, { title: '李四 整理综述' }],
      },
    });
    expect(res.statusCode).toBe(201);
    const list = res.json<Todo[]>();
    expect(list.map((x) => x.title)).toEqual(['完成 exp-08 消融', '李四 整理综述']);
    expect(list[0]).toMatchObject({
      assigneeId: MEMBER,
      ownerUserId: null,
      source: { kind: 'report', id: created.id },
    });

    const empty = await t.app.inject({
      method: 'POST',
      url: `${BASE}/${created.id}/todos`,
      headers: t.as(OWNER),
      payload: { items: [] },
    });
    expect(empty.statusCode).toBe(422);
  });
});

describe('存为文档', () => {
  it('没有正文时 400', async () => {
    const r = (await create({ generate: false })).json<Report>();
    const res = await t.app.inject({
      method: 'POST',
      url: `${BASE}/${r.id}/document`,
      headers: t.as(OWNER),
    });
    expect(res.statusCode).toBe(400);
  });

  const documentsReady = existsSync(
    fileURLToPath(new URL('../../src/modules/documents/service.ts', import.meta.url)),
  );
  it.skipIf(!documentsReady)('另存为协同文档；再存一次 409 并带 documentId', async () => {
    const created = (await create()).json<Report>();
    await waitForReportJobs();
    const res = await t.app.inject({
      method: 'POST',
      url: `${BASE}/${created.id}/document`,
      headers: t.as(OWNER),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ report: Report; document: DocumentMeta }>();
    expect(body.report.documentId).toBe(body.document.id);
    expect(body.document.title).toBe(created.title);

    const again = await t.app.inject({
      method: 'POST',
      url: `${BASE}/${created.id}/document`,
      headers: t.as(OWNER),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { details: { documentId: body.document.id } } });
  });
});

describe('提示词', () => {
  it('能找到 prompts/report.md', () => {
    expect(resolvePromptPath()).toMatch(/prompts[\\/]report\.md$/u);
  });
});
