import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorRef } from '@srh/shared';
import { personalMemory, plans, teamBasis } from '../src/db/schema';
import { estimateTokens } from '../src/agents/runtime/budget';
import { EXPLORATION_LABEL, renderMemory } from '../src/agents/runtime/context';
import { setupCollabApp, type CollabTestApp } from './collab/helpers';

/**
 * <memory> 里的方案与依据（plans 模块）：正式方案、团队依据、探索副本、本轮成员的个人工作记忆。
 * 数据直接写库，只测 renderMemory 的渲染与预算。
 */
const OWNER = 'usr_ctx_owner';
const ZHANG = 'usr_ctx_zhang';
const LI = 'usr_ctx_li';
const FORMER = 'usr_ctx_former';
const human = (id: string, name: string): ActorRef => ({ kind: 'user', id, name });

let t: CollabTestApp;
let seq = 0;
const nid = (p: string) => `${p}_${++seq}`;

async function project(id: string) {
  await t.seedProject(id, OWNER);
  await t.addMember(id, ZHANG, 'member');
  await t.addMember(id, LI, 'member');
}

async function official(projectId: string, content: string, version = 3) {
  await t.db.db.insert(plans).values({
    id: nid('pln'),
    projectId,
    kind: 'official',
    title: '图对比学习主线',
    summary: '先做分子图，后迁移到蛋白',
    content,
    version,
    createdBy: human(OWNER, '负责人'),
  });
}

async function exploration(projectId: string, title: string, summary: string, status = 'active') {
  await t.db.db.insert(plans).values({
    id: nid('pln'),
    projectId,
    kind: 'exploration',
    title,
    summary,
    content: '探索正文不应出现',
    version: 1,
    forkedFromVersion: 3,
    ownerId: ZHANG,
    status: status as 'active',
    createdBy: human(ZHANG, '张三'),
  });
}

async function basis(
  projectId: string,
  title: string,
  extra: Partial<typeof teamBasis.$inferInsert> = {},
) {
  await t.db.db.insert(teamBasis).values({
    id: nid('tb'),
    projectId,
    title,
    content: `${title}的正文`,
    claimType: 'observation',
    conditions: '仅在 ZINC 子集、batch=256 时',
    planVersion: 3,
    proposalId: nid('bp'),
    proposerId: ZHANG,
    proposer: human(ZHANG, '张三'),
    approvedBy: human(OWNER, '负责人'),
    ...extra,
  });
}

async function memo(projectId: string, userId: string, title: string, content: string) {
  await t.db.db.insert(personalMemory).values({
    id: nid('pm'),
    projectId,
    userId,
    title,
    content,
    updatedBy: human(userId, '成员'),
  });
}

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser(OWNER, '负责人', 0);
  await t.seedUser(ZHANG, '张三', 1);
  await t.seedUser(LI, '李四', 2);
  await t.seedUser(FORMER, '前成员', 3);
}, 60_000);

afterAll(() => t?.close());

describe('<memory> 里的个人工作记忆', () => {
  const P = 'prj_ctx_personal';
  beforeAll(async () => {
    await project(P);
    await memo(P, ZHANG, '张三的习惯', '张三喜欢先看消融实验');
    await memo(P, LI, '李四的私事', '李四下周请假不想让人知道');
    // FORMER 留下过记忆，但已不在项目成员里
    await memo(P, FORMER, '前成员笔记', '前成员留下的想法');
    // 别的项目里张三的记忆也不能串过来
    await project('prj_ctx_other');
    await memo('prj_ctx_other', ZHANG, '别的项目', '另一个项目的记忆');
  });

  it('只注入本轮成员本人的个人记忆，不出现其他成员的', async () => {
    const out = await renderMemory(t.app.ctx, P, { actorUserId: ZHANG });
    expect(out).toContain('张三的个人工作记忆');
    expect(out).toContain('张三喜欢先看消融实验');
    expect(out).not.toContain('李四下周请假');
    expect(out).not.toContain('李四的私事');
    expect(out).not.toContain('前成员留下的想法');
    expect(out).not.toContain('另一个项目的记忆');

    const li = await renderMemory(t.app.ctx, P, { actorUserId: LI });
    expect(li).toContain('李四下周请假不想让人知道');
    expect(li).not.toContain('张三喜欢先看消融实验');
  });

  it('没有本轮成员时不注入任何人的个人记忆', async () => {
    const out = await renderMemory(t.app.ctx, P);
    expect(out).not.toContain('个人工作记忆');
    expect(out).not.toContain('张三喜欢先看消融实验');
    expect(out).not.toContain('李四下周请假');
  });

  it('已经不是项目成员的人，个人记忆也不注入', async () => {
    const out = await renderMemory(t.app.ctx, P, { actorUserId: FORMER });
    expect(out).not.toContain('个人工作记忆');
    expect(out).not.toContain('前成员留下的想法');
    const nobody = await renderMemory(t.app.ctx, P, { actorUserId: 'usr_ctx_nobody' });
    expect(nobody).not.toContain('个人工作记忆');
  });
});

describe('<memory> 里的正式方案与团队依据', () => {
  const P = 'prj_ctx_plan';
  beforeAll(async () => {
    await project(P);
    await official(P, '## 要点\n1. 用 GIN 作为编码器\n2. 负样本用 <hard> 采样');
    await basis(P, '温度 0.1 最优', { claimType: 'observation' });
    await basis(P, '主线改用 GIN', { claimType: 'decision', conditions: '' });
    await basis(P, '数据增强可能有害', {
      claimType: 'hypothesis',
      status: 'needs_review',
      reviewReason: '正式方案已更新到 v4',
    });
    await basis(P, '旧结论', { status: 'superseded' });
    await basis(P, '停用结论', { status: 'retired' });
  });

  it('注入正式方案的版本号和要点，正文转义', async () => {
    const out = await renderMemory(t.app.ctx, P);
    expect(out).toContain('## 正式方案：图对比学习主线（v3');
    expect(out).toContain('说明：先做分子图，后迁移到蛋白');
    expect(out).toContain('1. 用 GIN 作为编码器');
    expect(out).toContain('负样本用 &lt;hard&gt; 采样');
    expect(out).not.toContain('<hard>');
    expect(out).not.toContain('已截断');
  });

  it('团队依据带类型和适用条件；待复核的标出来，已替代 / 停用的不注入', async () => {
    const out = await renderMemory(t.app.ctx, P);
    expect(out).toContain('## 团队依据');
    expect(out).toContain(
      '[实验观察] 温度 0.1 最优（适用条件：仅在 ZINC 子集、batch=256 时；依据方案 v3）',
    );
    expect(out).toContain('[正式决定] 主线改用 GIN（适用条件：未写明');
    expect(out).toContain('[假设，待复核] 数据增强可能有害');
    expect(out).toContain('待复核原因：正式方案已更新到 v4');
    expect(out).toContain('温度 0.1 最优的正文');
    expect(out).not.toContain('旧结论');
    expect(out).not.toContain('停用结论');
    // 有效的排在待复核前面
    expect(out.indexOf('温度 0.1 最优')).toBeLessThan(out.indexOf('数据增强可能有害'));
  });

  it('归档的正式方案不注入；没有正式方案时不出现该段', async () => {
    const out = await renderMemory(t.app.ctx, 'prj_ctx_other');
    expect(out).not.toContain('## 正式方案');
    expect(out).not.toContain('## 团队依据');
    await project('prj_ctx_archived');
    await t.db.db.insert(plans).values({
      id: nid('pln'),
      projectId: 'prj_ctx_archived',
      kind: 'official',
      title: '归档方案',
      content: '归档正文',
      version: 2,
      status: 'archived',
      createdBy: human(OWNER, '负责人'),
    });
    const archived = await renderMemory(t.app.ctx, 'prj_ctx_archived');
    expect(archived).not.toContain('归档正文');
  });
});

describe('<memory> 里的探索副本', () => {
  const P = 'prj_ctx_explore';
  beforeAll(async () => {
    await project(P);
    await official(P, '正式要点');
    await exploration(P, '试试 Transformer 编码器', '想看看能不能超过 GIN');
    await exploration(P, '换损失函数', '');
    await exploration(P, '已归档的尝试', '不该出现', 'archived');
  });

  it('每个探索副本都标「探索中，非正式结论」，只给标题和说明', async () => {
    const out = await renderMemory(t.app.ctx, P);
    expect(out).toContain('## 探索副本');
    const lines = out
      .split('\n')
      .filter((l) => l.startsWith('- ') && (l.includes('换损失函数') || l.includes('Transformer')));
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l).toContain(`「${EXPLORATION_LABEL}」`);
    expect(out).toContain('张三，从正式方案 v3 分叉');
    expect(out).toContain('想看看能不能超过 GIN');
    expect(out).not.toContain('探索正文不应出现');
    expect(out).not.toContain('已归档的尝试');
    // 探索副本出现在正式方案之后，且不在正式方案段里
    const officialAt = out.indexOf('## 正式方案');
    const exploreAt = out.indexOf('## 探索副本');
    expect(officialAt).toBeGreaterThanOrEqual(0);
    expect(exploreAt).toBeGreaterThan(officialAt);
    expect(out.slice(officialAt, exploreAt)).not.toContain('Transformer');
  });
});

describe('<memory> 预算', () => {
  const P = 'prj_ctx_budget';
  beforeAll(async () => {
    await project(P);
    await official(P, `## 要点\n关键结论放在开头。\n${'方案细节'.repeat(5000)}\n结尾的秘密句子`, 7);
    for (let i = 0; i < 40; i++) await basis(P, `依据${i}`, { content: '依'.repeat(800) });
    for (let i = 0; i < 20; i++) await exploration(P, `探索${i}`, '说'.repeat(500));
    for (let i = 0; i < 30; i++) await memo(P, ZHANG, `记忆${i}`, '忆'.repeat(800));
  });

  it('正式方案超出预算时截断并提示去页面看全文，整块不超过记忆预算', async () => {
    for (const budgetTokens of [6000, 2000, 800]) {
      const out = await renderMemory(t.app.ctx, P, { budgetTokens, actorUserId: ZHANG });
      expect(estimateTokens(out), `budget ${budgetTokens}`).toBeLessThanOrEqual(budgetTokens);
      expect(out).toContain('## 正式方案：图对比学习主线（v7');
      expect(out).toContain('关键结论放在开头');
      expect(out).not.toContain('结尾的秘密句子');
      expect(out).toContain('正式方案 v7 超出记忆预算，已截断；全文在「方案与依据」页面');
      expect(out.endsWith('</memory>')).toBe(true);
    }
  });

  it('条目放不下时列出未展开的数量，探索副本的标签不丢', async () => {
    const out = await renderMemory(t.app.ctx, P, { budgetTokens: 6000, actorUserId: ZHANG });
    expect(out).toMatch(/另有 \d+ 条团队依据未展开/u);
    expect(out).toMatch(/另有 \d+ 条个人工作记忆未展开/u);
    expect(out).toMatch(/另有 \d+ 个探索副本未展开/u);
    for (const l of out.split('\n').filter((x) => /^- .*探索\d+/u.test(x))) {
      expect(l).toContain(`「${EXPLORATION_LABEL}」`);
    }
  });

  it('默认预算（6000）下也不超', async () => {
    const out = await renderMemory(t.app.ctx, P, { actorUserId: ZHANG });
    expect(estimateTokens(out)).toBeLessThanOrEqual(6000);
  });
});
