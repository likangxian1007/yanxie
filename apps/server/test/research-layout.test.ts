import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResearchItem, ResearchRecord } from '@srh/shared';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';

let t: TestApp, owner: Session, guest: Session, outsider: Session, root: string;
beforeAll(async () => {
  t = await makeApp();
  const setup = await setupProject(t.app, ['guest']);
  owner = setup.owner;
  guest = setup.others[0]!;
  outsider = await signup(t.app);
  root = `/projects/${setup.project.id}/research`;
}, 60000);
afterAll(async () => t?.close());

async function fixture() {
  const record = (
    await owner.req('POST', `${root}/workspaces`, { title: '布局测试' })
  ).json<ResearchRecord>();
  const base = `${root}/records/${record.id}`;
  const a = (
    await owner.req('POST', `${base}/items`, { kind: 'note', title: '甲' })
  ).json<ResearchItem>();
  const b = (
    await owner.req('POST', `${base}/items`, { kind: 'note', title: '乙' })
  ).json<ResearchItem>();
  return { base, a, b };
}

describe('批量布局', () => {
  it('整体提交、幂等重放，正文并发不冲突', async () => {
    const { base, a, b } = await fixture();
    const events: string[] = [];
    const off = t.app.ctx.bus.onEvent((event) => {
      if (event.type === 'research.item.updated') events.push(event.payload.id);
    });
    const input = {
      idempotencyKey: 'layout_123',
      moves: [
        { itemId: a.id, basePositionVersion: 1, position: { x: 15, y: 30 } },
        { itemId: b.id, basePositionVersion: 1, position: { x: 50, y: 90 } },
      ],
    };
    const edited = await owner.req('PATCH', `${base}/items/${a.id}`, {
      baseVersion: 1,
      body: '并发编辑',
    });
    expect(edited.statusCode).toBe(200);
    events.length = 0;
    const response = await owner.req('PATCH', `${base}/layout`, input);
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json<{ items: ResearchItem[] }>();
    expect(saved.items).toMatchObject([
      { id: a.id, body: '并发编辑', version: 2, positionVersion: 2, position: { x: 15, y: 30 } },
      { id: b.id, positionVersion: 2, position: { x: 50, y: 90 } },
    ]);
    expect(events).toEqual([a.id, b.id]);
    expect((await owner.req('PATCH', `${base}/layout`, input)).json()).toEqual(saved);
    expect(events).toEqual([a.id, b.id]);
    expect(
      (await owner.req('PATCH', `${base}/layout`, { ...input, moves: input.moves.slice(0, 1) }))
        .statusCode,
    ).toBe(409);
    off();
  });

  it('任一位置版本冲突整批回滚，并返回双方可比较的当前布局', async () => {
    const { base, a, b } = await fixture();
    const edited = await owner.req('PATCH', `${base}/items/${b.id}/position`, {
      basePositionVersion: 1,
      position: { x: 300, y: 400 },
    });
    expect(edited.statusCode).toBe(200);
    const response = await owner.req('PATCH', `${base}/layout`, {
      idempotencyKey: 'layout_456',
      moves: [
        { itemId: a.id, basePositionVersion: 1, position: { x: 1, y: 2 } },
        { itemId: b.id, basePositionVersion: 1, position: { x: 3, y: 4 } },
      ],
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.current).toMatchObject([
      { id: a.id, positionVersion: 1, position: a.position },
      { id: b.id, positionVersion: 2, position: { x: 300, y: 400 } },
    ]);
    expect((await owner.req('GET', `${base}/items/${a.id}`)).json<ResearchItem>().position).toEqual(
      a.position,
    );
  });

  it('校验重复或无效位置，拒绝越权和跨研究引用', async () => {
    const { base, a } = await fixture();
    const other = await fixture();
    const move = { itemId: a.id, basePositionVersion: 1, position: { x: 1, y: 2 } };
    const idempotencyKey = 'layout_789';
    expect(
      (await owner.req('PATCH', `${base}/layout`, { idempotencyKey, moves: [move, move] }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await owner.req('PATCH', `${base}/layout`, {
          idempotencyKey,
          moves: [{ ...move, position: { x: 'bad', y: 0 } }],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await owner.req('PATCH', `${base}/layout`, {
          idempotencyKey,
          moves: [{ ...move, itemId: other.a.id }],
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await guest.req('PATCH', `${base}/layout`, { idempotencyKey, moves: [move] })).statusCode,
    ).toBe(403);
    expect(
      (await outsider.req('PATCH', `${base}/layout`, { idempotencyKey, moves: [move] })).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: `/api/v1${base}/layout`,
          payload: { moves: [move] },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('支持请求头幂等键并拒绝头和正文不一致', async () => {
    const { base, a } = await fixture();
    const moves = [{ itemId: a.id, basePositionVersion: 1, position: { x: 9, y: 8 } }];
    const result = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1${base}/layout`,
      headers: { cookie: owner.cookie, 'idempotency-key': 'layout_header' },
      payload: { moves },
    });
    expect(result.statusCode, result.body).toBe(200);
    const conflict = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1${base}/layout`,
      headers: { cookie: owner.cookie, 'idempotency-key': 'layout_header' },
      payload: { moves, idempotencyKey: 'layout_other' },
    });
    expect(conflict.statusCode).toBe(422);
  });
});
