import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { generateKeyBetween } from 'fractional-indexing';
import type { ActorRef, Board, BoardColumn, Card } from '@srh/shared';
import { collab } from '../../src/agents/tools/collab-port';
import { inboxItems, threads } from '../../src/db/schema';
import { setupCollabApp, type CollabTestApp } from './helpers';

const P = 'prj_board';
const OTHER = 'prj_board_other';
const base = `/api/v1/projects/${P}`;

let t: CollabTestApp;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function req(user: string, method: Method, url: string, payload?: unknown) {
  return t.app.inject({
    method,
    url: url.startsWith('/api') ? url : `${base}${url}`,
    headers: t.as(user),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function lastEvent(type: string, projectId = P) {
  const events = await t.app.ctx.bus.listSince(projectId, 0, 10_000);
  return events.filter((e) => e.type === type).at(-1);
}

async function boardWithCards(boardId: string) {
  const res = await req('usr_owner', 'GET', `/boards/${boardId}`);
  expect(res.statusCode).toBe(200);
  return res.json<Board & { cards: Card[] }>();
}

function titlesIn(board: Board & { cards: Card[] }, columnId: string) {
  return board.cards.filter((c) => c.columnId === columnId).map((c) => c.title);
}

let board: Board;
let cols: BoardColumn[];

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser('usr_owner', '王老师');
  await t.seedUser('usr_mem', '张三');
  await t.seedUser('usr_guest', '访客甲');
  await t.seedUser('usr_out', '路人');
  await t.seedProject(P, 'usr_owner');
  await t.addMember(P, 'usr_mem', 'member');
  await t.addMember(P, 'usr_guest', 'guest');
  await t.seedProject(OTHER, 'usr_out');
  await t.db.db.insert(threads).values([
    { id: 'thr_alpha', projectId: P, rootMessageId: 'msg_alpha', title: '复现基线' },
    { id: 'thr_beta', projectId: P, rootMessageId: 'msg_beta', title: '消融实验' },
    { id: 'thr_foreign', projectId: OTHER, rootMessageId: 'msg_f', title: '别的项目' },
  ]);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('boards', () => {
  it('GET 自动创建默认看板，且幂等', async () => {
    const res = await req('usr_mem', 'GET', '/boards');
    expect(res.statusCode).toBe(200);
    const list = res.json<Board[]>();
    expect(list).toHaveLength(1);
    board = list[0]!;
    expect(board.name).toBe('研究看板');
    expect(board.columns.map((c) => c.name)).toEqual(['想法', '进行中', '待审阅', '完成']);
    expect(board.columns.map((c) => c.color)).toEqual([1, 2, 0, 4]);
    cols = board.columns;
    expect(await lastEvent('board.created')).toMatchObject({ payload: { id: board.id } });

    const again = await req('usr_owner', 'GET', '/boards');
    expect(again.json<Board[]>().map((b) => b.id)).toEqual([board.id]);
  });

  it('非成员 404，访客能看不能写', async () => {
    expect((await req('usr_out', 'GET', '/boards')).statusCode).toBe(404);
    expect((await req('usr_out', 'GET', `/boards/${board.id}`)).statusCode).toBe(404);
    expect((await req('usr_guest', 'GET', `/boards/${board.id}`)).statusCode).toBe(200);
    const res = await req('usr_guest', 'POST', `/boards/${board.id}/cards`, {
      columnId: cols[0]!.id,
      title: '访客想加卡片',
    });
    expect(res.statusCode).toBe(403);
    expect((await req('usr_guest', 'POST', '/boards', { name: 'x' })).statusCode).toBe(403);
  });

  it('新建、改名、删除看板；最后一个看板不能删', async () => {
    const created = await req('usr_owner', 'POST', '/boards', {
      name: '论文写作',
      columns: ['草稿', '定稿'],
    });
    expect(created.statusCode).toBe(201);
    const b = created.json<Board>();
    expect(b.columns.map((c) => c.name)).toEqual(['草稿', '定稿']);
    expect(b.columns[0]!.position < b.columns[1]!.position).toBe(true);

    const defaults = await req('usr_owner', 'POST', '/boards', { name: '默认列' });
    expect(defaults.json<Board>().columns).toHaveLength(4);
    expect(
      (await req('usr_owner', 'DELETE', `/boards/${defaults.json<Board>().id}`)).statusCode,
    ).toBe(204);

    const renamed = await req('usr_owner', 'PATCH', `/boards/${b.id}`, { name: '论文' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Board>().name).toBe('论文');
    expect(await lastEvent('board.updated')).toMatchObject({ payload: { id: b.id, name: '论文' } });

    expect((await req('usr_owner', 'DELETE', `/boards/${b.id}`)).statusCode).toBe(204);
    expect(await lastEvent('board.deleted')).toMatchObject({ payload: { id: b.id } });
    expect((await req('usr_owner', 'GET', `/boards/${b.id}`)).statusCode).toBe(404);

    const last = await req('usr_owner', 'DELETE', `/boards/${board.id}`);
    expect(last.statusCode).toBe(409);
    expect(last.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  it('建列：默认放在末尾，可改名改色', async () => {
    const res = await req('usr_mem', 'POST', `/boards/${board.id}/columns`, {
      name: '搁置',
      color: 7,
    });
    expect(res.statusCode).toBe(201);
    const col = res.json<BoardColumn>();
    expect(col.position > cols.at(-1)!.position).toBe(true);
    expect(await lastEvent('column.created')).toMatchObject({ payload: { id: col.id } });

    const patched = await req('usr_mem', 'PATCH', `/columns/${col.id}`, { color: 5 });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<BoardColumn>()).toMatchObject({ name: '搁置', color: 5 });

    const full = await boardWithCards(board.id);
    expect(full.columns.map((c) => c.name)).toEqual(['想法', '进行中', '待审阅', '完成', '搁置']);
    cols = full.columns;
  });

  it('前端算出的列位置（同一个 fractional-indexing 算法）：末尾 / 开头 / 中间 / 空看板都能通过校验', async () => {
    // 前端 apps/web/src/features/board/lib/position.ts 的 positionBetween 就是 generateKeyBetween
    const tmp = await req('usr_owner', 'POST', '/boards', { name: '位置校验', columns: ['甲'] });
    const b = tmp.json<Board>();
    const add = async (name: string, position: string) =>
      req('usr_mem', 'POST', `/boards/${b.id}/columns`, { name, position });
    const only = b.columns[0]!.position;

    const end = await add('末尾', generateKeyBetween(only, null));
    expect(end.statusCode).toBe(201);
    const start = await add('开头', generateKeyBetween(null, only));
    expect(start.statusCode).toBe(201);
    const mid = await add('中间', generateKeyBetween(only, end.json<BoardColumn>().position));
    expect(mid.statusCode).toBe(201);
    const full = await boardWithCards(b.id);
    expect(full.columns.map((c) => c.name)).toEqual(['开头', '甲', '中间', '末尾']);

    // 改列位置（拖动排序）也一样
    const moved = await req('usr_mem', 'PATCH', `/columns/${start.json<BoardColumn>().id}`, {
      position: generateKeyBetween(end.json<BoardColumn>().position, null),
    });
    expect(moved.statusCode).toBe(200);
    expect((await boardWithCards(b.id)).columns.map((c) => c.name)).toEqual([
      '甲',
      '中间',
      '末尾',
      '开头',
    ]);

    // 空列表时的第一个位置
    expect(generateKeyBetween(null, null)).toBe('a0');
    expect((await add('空表首位', generateKeyBetween(null, null))).statusCode).toBe(201);

    // 旧前端 base62 算法在 a3 之后给出的 "n" 不是合法位置
    const bad = await add('旧算法', 'n');
    expect(bad.statusCode).toBe(422);
    await req('usr_owner', 'DELETE', `/boards/${b.id}`);
  });

  it('建卡：列尾 / 列首 / 插在某张之后', async () => {
    const col = cols[0]!.id;
    const add = async (title: string, afterCardId?: string | null) => {
      const res = await req('usr_mem', 'POST', `/boards/${board.id}/cards`, {
        columnId: col,
        title,
        ...(afterCardId === undefined ? {} : { afterCardId }),
      });
      expect(res.statusCode).toBe(201);
      return res.json<Card>();
    };
    const b = await add('B');
    await add('D');
    await add('A', null);
    await add('C', b.id);
    expect(titlesIn(await boardWithCards(board.id), col)).toEqual(['A', 'B', 'C', 'D']);
    const ev = await lastEvent('card.created');
    expect(ev).toMatchObject({ payload: { title: 'C', version: 1 }, threadId: null });
  });

  it('跨列移动与列内排序，version 递增', async () => {
    const [src, dst] = [cols[0]!.id, cols[1]!.id];
    let full = await boardWithCards(board.id);
    const byTitle = (title: string) => full.cards.find((c) => c.title === title)!;

    // 只改列：放到目标列末尾
    const moved = await req('usr_mem', 'PATCH', `/cards/${byTitle('B').id}`, {
      columnId: dst,
      baseVersion: 1,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<Card>()).toMatchObject({ columnId: dst, version: 2 });
    await req('usr_mem', 'PATCH', `/cards/${byTitle('D').id}`, { columnId: dst, baseVersion: 1 });

    // 移到目标列 B 之后（D 之前）
    await req('usr_mem', 'PATCH', `/cards/${byTitle('A').id}`, {
      columnId: dst,
      afterCardId: byTitle('B').id,
      baseVersion: 1,
    });
    full = await boardWithCards(board.id);
    expect(titlesIn(full, src)).toEqual(['C']);
    expect(titlesIn(full, dst)).toEqual(['B', 'A', 'D']);

    // 列内移到最前
    const d = full.cards.find((c) => c.title === 'D')!;
    await req('usr_mem', 'PATCH', `/cards/${d.id}`, { afterCardId: null, baseVersion: d.version });
    full = await boardWithCards(board.id);
    expect(titlesIn(full, dst)).toEqual(['D', 'B', 'A']);
    expect(await lastEvent('card.updated')).toMatchObject({ payload: { id: d.id, version: 3 } });
  });

  it('baseVersion 过期 → 409 version_conflict 带最新对象', async () => {
    const full = await boardWithCards(board.id);
    const card = full.cards.find((c) => c.title === 'C')!;
    const ok = await req('usr_owner', 'PATCH', `/cards/${card.id}`, {
      title: 'C 改',
      baseVersion: card.version,
    });
    expect(ok.statusCode).toBe(200);
    const stale = await req('usr_mem', 'PATCH', `/cards/${card.id}`, {
      title: 'C 另一处修改',
      baseVersion: card.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        code: 'version_conflict',
        details: { current: { id: card.id, title: 'C 改', version: card.version + 1 } },
      },
    });
    const missing = await req('usr_mem', 'PATCH', `/cards/${card.id}`, { title: '没带版本' });
    expect(missing.statusCode).toBe(422);
  });

  it('columnId 不属于这个看板 → 422', async () => {
    const other = await req('usr_owner', 'POST', '/boards', { name: '另一个', columns: ['甲'] });
    const foreignCol = other.json<Board>().columns[0]!.id;
    const res = await req('usr_mem', 'POST', `/boards/${board.id}/cards`, {
      columnId: foreignCol,
      title: '放错列',
    });
    expect(res.statusCode).toBe(422);
    const card = (await boardWithCards(board.id)).cards[0]!;
    const moved = await req('usr_mem', 'PATCH', `/cards/${card.id}`, {
      columnId: foreignCol,
      baseVersion: card.version,
    });
    expect(moved.statusCode).toBe(422);
    const bogus = await req('usr_mem', 'POST', `/boards/${board.id}/cards`, {
      columnId: 'col_nope',
      title: '不存在的列',
    });
    expect(bogus.statusCode).toBe(422);
    await req('usr_owner', 'DELETE', `/boards/${other.json<Board>().id}`);
  });

  it('指派给成员 → 收件箱；指派给自己不提醒；非成员 422', async () => {
    const res = await req('usr_owner', 'POST', `/boards/${board.id}/cards`, {
      columnId: cols[2]!.id,
      title: '整理消融结果',
      assigneeIds: ['usr_mem', 'usr_owner', 'usr_mem'],
    });
    expect(res.statusCode).toBe(201);
    const card = res.json<Card>();
    expect(card.assigneeIds).toEqual(['usr_mem', 'usr_owner']);
    const items = await t.db.db.select().from(inboxItems).where(eq(inboxItems.sourceId, card.id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      userId: 'usr_mem',
      kind: 'assignment',
      title: '「整理消融结果」指派给了你',
      href: `/p/${P}/board?card=${card.id}`,
    });

    // 再改一次指派：已有的不重复提醒
    await req('usr_owner', 'PATCH', `/cards/${card.id}`, {
      assigneeIds: ['usr_mem'],
      baseVersion: 1,
    });
    const after = await t.db.db.select().from(inboxItems).where(eq(inboxItems.sourceId, card.id));
    expect(after).toHaveLength(1);

    const bad = await req('usr_owner', 'POST', `/boards/${board.id}/cards`, {
      columnId: cols[2]!.id,
      title: '指派给路人',
      assigneeIds: ['usr_out'],
    });
    expect(bad.statusCode).toBe(422);
  });

  it('指派给 agent：事件 threadId 指向该线程；卡片自带 threadId 优先；协调者为 null', async () => {
    const res = await req('usr_mem', 'POST', `/boards/${board.id}/cards`, {
      columnId: cols[1]!.id,
      title: '跑一遍基线',
      assigneeIds: ['agent:thr_alpha'],
    });
    expect(res.statusCode).toBe(201);
    const card = res.json<Card>();
    expect(await lastEvent('card.created')).toMatchObject({
      threadId: 'thr_alpha',
      payload: { id: card.id },
    });

    // 改标题：没有新增 agent 指派，卡片没绑线程 → null
    await req('usr_mem', 'PATCH', `/cards/${card.id}`, { title: '跑两遍基线', baseVersion: 1 });
    expect(await lastEvent('card.updated')).toMatchObject({ threadId: null });

    // 新增另一个线程的指派
    await req('usr_mem', 'PATCH', `/cards/${card.id}`, {
      assigneeIds: ['agent:thr_alpha', 'agent:thr_beta'],
      baseVersion: 2,
    });
    expect(await lastEvent('card.updated')).toMatchObject({ threadId: 'thr_beta' });

    // 卡片自带 threadId 优先
    const bound = await req('usr_mem', 'POST', `/boards/${board.id}/cards`, {
      columnId: cols[1]!.id,
      title: '绑定线程的卡',
      threadId: 'thr_beta',
      assigneeIds: ['agent:thr_alpha'],
    });
    expect(await lastEvent('card.created')).toMatchObject({
      threadId: 'thr_beta',
      payload: { id: bound.json<Card>().id },
    });

    // 协调者
    await req('usr_mem', 'POST', `/boards/${board.id}/cards`, {
      columnId: cols[1]!.id,
      title: '交给协调者',
      assigneeIds: ['agent:coordinator'],
    });
    expect(await lastEvent('card.created')).toMatchObject({
      threadId: null,
      payload: { assigneeIds: ['agent:coordinator'] },
    });

    // 别的项目的线程 / 格式不对 → 422
    for (const assignee of ['agent:thr_foreign', 'agent:']) {
      const bad = await req('usr_mem', 'POST', `/boards/${board.id}/cards`, {
        columnId: cols[1]!.id,
        title: '非法指派',
        assigneeIds: [assignee],
      });
      expect(bad.statusCode).toBe(422);
    }
  });

  it('删除非空列 409；moveTo 把卡片移到目标列末尾', async () => {
    const colRes = await req('usr_mem', 'POST', `/boards/${board.id}/columns`, { name: '临时' });
    const tmp = colRes.json<BoardColumn>();
    for (const title of ['T1', 'T2']) {
      await req('usr_mem', 'POST', `/boards/${board.id}/cards`, { columnId: tmp.id, title });
    }
    const blocked = await req('usr_mem', 'DELETE', `/columns/${tmp.id}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: 'conflict', message: '这一列还有卡片，先移走或指定 moveTo' },
    });

    const target = cols[3]!.id; // 完成
    await req('usr_mem', 'POST', `/boards/${board.id}/cards`, {
      columnId: target,
      title: '已完成的',
    });
    const before = await t.app.ctx.bus.latestSeq(P);
    const del = await req('usr_mem', 'DELETE', `/columns/${tmp.id}?moveTo=${target}`);
    expect(del.statusCode).toBe(204);

    const full = await boardWithCards(board.id);
    expect(full.columns.some((c) => c.id === tmp.id)).toBe(false);
    expect(titlesIn(full, target)).toEqual(['已完成的', 'T1', 'T2']);
    const evs = await t.app.ctx.bus.listSince(P, before);
    expect(evs.map((e) => e.type)).toEqual(['card.updated', 'card.updated', 'column.deleted']);

    // 空列可以直接删
    const empty = await req('usr_mem', 'POST', `/boards/${board.id}/columns`, { name: '空列' });
    expect(
      (await req('usr_mem', 'DELETE', `/columns/${empty.json<BoardColumn>().id}`)).statusCode,
    ).toBe(204);
  });

  it('删除卡片：发 card.deleted，并把相关收件箱项标为完成', async () => {
    const res = await req('usr_owner', 'POST', `/boards/${board.id}/cards`, {
      columnId: cols[0]!.id,
      title: '要删的卡',
      assigneeIds: ['usr_mem'],
    });
    const card = res.json<Card>();
    expect((await req('usr_mem', 'DELETE', `/cards/${card.id}`)).statusCode).toBe(204);
    expect(await lastEvent('card.deleted')).toMatchObject({ payload: { id: card.id } });
    const [item] = await t.db.db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.sourceId, card.id), eq(inboxItems.userId, 'usr_mem')));
    expect(item?.doneAt).toBeInstanceOf(Date);
    expect((await req('usr_mem', 'DELETE', `/cards/${card.id}`)).statusCode).toBe(404);
  });

  it('端口已注册：createCard 缺省用默认看板第一列', async () => {
    const port = collab('boards');
    expect(port).toBeDefined();
    const agent: ActorRef = { kind: 'agent', id: 'agt_x', name: '线程 agent' };
    const card = await port!.createCard(t.app.ctx, agent, P, { title: 'agent 建的卡' });
    expect(card.boardId).toBe(board.id);
    expect(card.columnId).toBe(cols[0]!.id);
    expect(card.createdBy).toEqual(agent);

    const ensured = await port!.ensureDefaultBoard(t.app.ctx, agent, P);
    expect(ensured.id).toBe(board.id);

    const updated = await port!.updateCard(t.app.ctx, agent, P, card.id, {
      columnId: cols[1]!.id,
      baseVersion: 1,
    });
    expect(updated).toMatchObject({ columnId: cols[1]!.id, version: 2 });

    // 新项目：端口自动建默认看板
    await t.seedProject('prj_board_fresh', 'usr_owner');
    const fresh = await port!.createCard(t.app.ctx, agent, 'prj_board_fresh', { title: '第一张' });
    const boards = await req('usr_owner', 'GET', '/api/v1/projects/prj_board_fresh/boards');
    expect(boards.json<Board[]>()).toHaveLength(1);
    expect(fresh.columnId).toBe(boards.json<Board[]>()[0]!.columns[0]!.id);
  });
});
