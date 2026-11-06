import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ResearchItem,
  ResearchRecord,
  ResearchRelation,
  ResearchWorkspace,
} from '@srh/shared';
import { researchEntities, researchWorkspaceItems } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';

let t: TestApp, owner: Session, guest: Session, outsider: Session, projectId: string, p: string;
beforeAll(async () => {
  t = await makeApp();
  const setup = await setupProject(t.app, ['guest']);
  owner = setup.owner;
  guest = setup.others[0]!;
  outsider = await signup(t.app);
  projectId = setup.project.id;
  p = `/projects/${projectId}/research`;
}, 60000);
afterAll(async () => {
  await t?.close();
});

describe('研究工作区', () => {
  it('并发新增未摆放的产物时分配不同位置，不把结果堆叠在原点', async () => {
    const record = (
      await owner.req('POST', `${p}/workspaces`, { title: '布局并发' })
    ).json<ResearchRecord>();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        owner.req('POST', `${p}/records/${record.id}/items`, {
          kind: 'note',
          title: `产物 ${index}`,
          body: '实际产物内容',
        }),
      ),
    );
    const positions = results.map((response) => {
      expect(response.statusCode, response.body).toBe(201);
      return response.json<ResearchItem>().position;
    });
    expect(new Set(positions.map((position) => `${position.x}:${position.y}`)).size).toBe(5);
    expect(positions.every((position) => position.x !== 0 || position.y !== 0)).toBe(true);
    for (const [i, a] of positions.entries())
      for (const b of positions.slice(i + 1))
        expect(Math.abs(a.x - b.x) >= 250 || Math.abs(a.y - b.y) >= 220).toBe(true);
  });
  it('空输入创建、幂等、保存条目和语义关系，正文与位置独立并发', async () => {
    const seen: string[] = [];
    const off = t.app.ctx.bus.onEvent((e) => {
      if (e.projectId === projectId) seen.push(e.type);
    });
    const created = await owner.req('POST', `${p}/workspaces`, { idempotencyKey: 'create_123' });
    expect(created.statusCode).toBe(201);
    const record = created.json<ResearchRecord>();
    expect(record).toMatchObject({
      title: '未命名研究',
      question: '',
      templateId: 'rtpl_preset_general',
      fieldValues: {},
    });
    expect(
      (
        await owner.req('POST', `${p}/workspaces`, { idempotencyKey: 'create_123' })
      ).json<ResearchRecord>().id,
    ).toBe(record.id);
    expect(
      (
        await owner.req('POST', `${p}/workspaces`, {
          title: '不同内容',
          idempotencyKey: 'create_123',
        })
      ).statusCode,
    ).toBe(409);
    const base = `${p}/records/${record.id}`;
    const itemInput = {
      kind: 'note',
      title: '观察',
      body: '长正文 '.repeat(100),
      idempotencyKey: 'itemkey_123',
    };
    const noteResponse = await owner.req('POST', `${base}/items`, itemInput);
    expect(noteResponse.statusCode).toBe(201);
    const note = noteResponse.json<ResearchItem>();
    expect((await owner.req('POST', `${base}/items`, itemInput)).json<ResearchItem>().id).toBe(
      note.id,
    );
    expect(
      (await owner.req('POST', `${base}/items`, { ...itemInput, title: '不同' })).statusCode,
    ).toBe(409);
    const group = (
      await owner.req('POST', `${base}/items`, { kind: 'group', title: '分组' })
    ).json<ResearchItem>();
    expect(
      (
        await owner.req('PATCH', `${base}/items/${note.id}`, {
          baseVersion: 1,
          parentId: group.id,
          body: '第一版内容',
        })
      ).statusCode,
    ).toBe(200);
    const moved = await owner.req('PATCH', `${base}/items/${note.id}/position`, {
      basePositionVersion: 1,
      position: { x: 42, y: 12 },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<ResearchItem>()).toMatchObject({
      version: 2,
      positionVersion: 2,
      body: '第一版内容',
    });
    const edited = await owner.req('PATCH', `${base}/items/${note.id}`, {
      baseVersion: 2,
      body: '第二版内容',
    });
    expect(edited.json<ResearchItem>()).toMatchObject({
      version: 3,
      positionVersion: 2,
      position: { x: 42, y: 12 },
    });
    const conflict = await owner.req('PATCH', `${base}/items/${note.id}`, {
      baseVersion: 2,
      body: '过期覆盖',
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.details.current.body).toBe('第二版内容');
    expect(
      (
        await owner.req('PATCH', `${base}/items/${note.id}/position`, {
          basePositionVersion: 1,
          position: { x: 0, y: 0 },
        })
      ).statusCode,
    ).toBe(409);
    expect((await owner.req('DELETE', `${base}/items/${group.id}?baseVersion=1`)).statusCode).toBe(
      409,
    );
    const relation = await owner.req('POST', `${base}/relations`, {
      fromItemId: group.id,
      toItemId: note.id,
      label: '包含',
    });
    expect(relation.statusCode).toBe(201);
    const relationId = relation.json<ResearchRelation>().id;
    expect(
      (
        await owner.req('PATCH', `${base}/relations/${relationId}`, {
          baseVersion: 1,
          label: '相关',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await owner.req('PATCH', `${base}/relations/${relationId}`, { baseVersion: 1, label: '旧' }))
        .statusCode,
    ).toBe(409);
    const workspace = (await owner.req('GET', `${base}/workspace`)).json<ResearchWorkspace>();
    expect(workspace.items.items).toHaveLength(2);
    const summary = workspace.items.items.find((x) => x.id === note.id)!;
    expect(summary.preview).toBe('第二版内容');
    expect(summary).not.toHaveProperty('body');
    expect(summary).not.toHaveProperty('action');
    expect(workspace.relations.items[0]?.label).toBe('相关');
    const first = (await owner.req('GET', `${base}/items?limit=1`)).json<{
      items: unknown[];
      nextCursor: string | null;
    }>();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(
      (await owner.req('GET', `${base}/items?limit=1&cursor=${first.nextCursor}`)).json().items,
    ).toHaveLength(1);
    expect((await owner.req('GET', `${base}/items/${note.id}`)).json<ResearchItem>().body).toBe(
      '第二版内容',
    );
    expect(seen).toContain('research.item.created');
    expect(seen).toContain('research.item.updated');
    expect(seen).toContain('research.relation.created');
    off();
  });

  it('验证权限、跨项目/个人资源并按需读取原件；旧记录读取不改库', async () => {
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/v1${p}/records/missing/workspace` }))
        .statusCode,
    ).toBe(401);
    const record = (
      await owner.req('POST', `${p}/records`, {
        templateId: 'rtpl_preset_qualitative',
        title: '旧记录',
        question: '原问题',
      })
    ).json<ResearchRecord>();
    const base = `${p}/records/${record.id}`;
    const otherRecord = (
      await owner.req('POST', `${p}/records`, {
        templateId: 'rtpl_preset_general',
        title: '来源所属研究',
      })
    ).json<ResearchRecord>();
    const source = await owner.req('POST', `${p}/records/${otherRecord.id}/sources`, {
      kind: 'bibliography',
      title: '项目共享来源',
      citation: '原始书目',
    });
    expect(source.statusCode).toBe(201);
    const sourceItem = await owner.req('POST', `${base}/items`, {
      kind: 'resource',
      title: '复用共享来源',
      evidenceRef: { kind: 'source', id: source.json().id },
    });
    expect(sourceItem.statusCode).toBe(201);
    expect(
      (await owner.req('GET', `${base}/items/${sourceItem.json<ResearchItem>().id}/content`)).json()
        .summary,
    ).toBe('原始书目');
    const before = await t.db.db
      .select()
      .from(researchEntities)
      .where(eq(researchEntities.id, record.id));
    expect((await owner.req('GET', `${base}/workspace`)).statusCode).toBe(200);
    const after = await t.db.db
      .select()
      .from(researchEntities)
      .where(eq(researchEntities.id, record.id));
    expect(after).toEqual(before);
    expect(
      await t.db.db
        .select()
        .from(researchWorkspaceItems)
        .where(eq(researchWorkspaceItems.recordId, record.id)),
    ).toHaveLength(1);
    expect((await guest.req('GET', `${base}/workspace`)).statusCode).toBe(200);
    expect(
      (await guest.req('POST', `${base}/items`, { kind: 'note', title: '禁止' })).statusCode,
    ).toBe(403);
    expect((await outsider.req('GET', `${base}/workspace`)).statusCode).toBe(404);
    expect(
      (await owner.req('POST', `${base}/items`, { kind: 'wrong', title: '无效' })).statusCode,
    ).toBe(422);
    const personal = await owner.req('POST', `/projects/${projectId}/docs`, {
      title: '个人',
      space: 'personal',
      markdown: '私人内容',
    });
    expect(personal.statusCode).toBe(201);
    const team = await owner.req('POST', `/projects/${projectId}/docs`, {
      title: '团队文档',
      markdown: '甲乙丙丁戊',
    });
    expect(team.statusCode).toBe(201);
    const docId = team.json().id;
    expect(
      (
        await owner.req('POST', `${base}/items`, {
          kind: 'resource',
          title: '私人引用',
          resource: { kind: 'document', id: personal.json().id },
        })
      ).statusCode,
    ).toBe(422);
    const another = await setupProject(t.app, []);
    const foreign = await another.owner.req('POST', `/projects/${another.project.id}/docs`, {
      title: '别的课题',
    });
    expect(
      (
        await owner.req('POST', `${base}/items`, {
          kind: 'resource',
          title: '越界',
          resource: { kind: 'document', id: foreign.json().id },
        })
      ).statusCode,
    ).toBe(422);
    const item = (
      await owner.req('POST', `${base}/items`, {
        kind: 'resource',
        title: '文档',
        resource: { kind: 'document', id: docId },
      })
    ).json<ResearchItem>();
    const content = await owner.req('GET', `${base}/items/${item.id}/content?limit=2`);
    expect(content.statusCode).toBe(200);
    expect(content.json()).toMatchObject({
      text: '甲乙',
      nextOffset: 2,
      resource: { kind: 'document', id: docId },
      unavailableReason: null,
    });
    const excerptInput = {
      kind: 'note',
      title: '摘录',
      body: '甲乙',
      idempotencyKey: 'excerpt-key-123',
      origin: {
        itemId: item.id,
        sourceVersion: content.json().version,
        quote: '甲乙',
        locator: { kind: 'text', start: 0, end: 2, segment: 0 },
      },
    };
    const [excerptFirst, excerptRetry] = await Promise.all([
      owner.req('POST', `${base}/items`, excerptInput),
      owner.req('POST', `${base}/items`, excerptInput),
    ]);
    expect(excerptFirst.statusCode).toBe(201);
    expect(excerptRetry.statusCode).toBe(201);
    const item2 = excerptFirst.json<ResearchItem>();
    expect(excerptRetry.json<ResearchItem>().id).toBe(item2.id);
    expect(item2.origin).toMatchObject({
      resource: { kind: 'document', id: docId },
      verification: 'unverified',
    });
    expect(item2.evidenceRef?.kind).toBe('excerpt');
    expect((await owner.req('POST', `${base}/items`, excerptInput)).json<ResearchItem>().id).toBe(
      item2.id,
    );
    expect(
      (await owner.req('POST', `${base}/items`, { ...excerptInput, body: '不同内容' })).statusCode,
    ).toBe(409);
    const excerpts = (await owner.req('GET', `${base}/excerpts`)).json().items;
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toMatchObject({
      id: item2.evidenceRef?.id,
      quote: '甲乙',
      verification: 'unverified',
      locator: { kind: 'manual' },
    });
    expect(excerpts[0].locator.note).toContain(docId);
    const snapshot = (await owner.req('GET', `${p}/snapshots/${excerpts[0].snapshotId}`)).json();
    expect(snapshot).toMatchObject({ coverage: 'excerpt', text: '甲乙' });
    const finding = await owner.req('POST', `${base}/findings`, {
      statement: '解释',
      supportingExcerptIds: [excerpts[0].id],
    });
    expect(finding.statusCode).toBe(201);
    expect(finding.json().supportingExcerptIds).toEqual([excerpts[0].id]);
    const editedNote = await owner.req('PATCH', `${base}/items/${item2.id}`, {
      baseVersion: 1,
      body: '编辑过的笔记',
    });
    expect(editedNote.statusCode).toBe(200);
    const editedContent = (await owner.req('GET', `${base}/items/${item2.id}/content`)).json();
    expect(editedContent.text).toBe('编辑过的笔记');
    const nested = (
      await owner.req('POST', `${base}/items`, {
        kind: 'note',
        title: '来自笔记的摘录',
        body: '编辑过',
        idempotencyKey: 'nested-key-123',
        origin: {
          itemId: item2.id,
          sourceVersion: editedContent.version,
          quote: '编辑过',
          locator: { kind: 'text', start: 0, end: 3, segment: 0 },
        },
      })
    ).json<ResearchItem>();
    const allExcerpts = (await owner.req('GET', `${base}/excerpts`)).json().items;
    const nestedExcerpt = allExcerpts.find(
      (entry: { id: string }) => entry.id === nested.evidenceRef?.id,
    );
    expect(nestedExcerpt.snapshotId).not.toBe(excerpts[0].snapshotId);
    expect(
      (await owner.req('GET', `${p}/snapshots/${nestedExcerpt.snapshotId}`)).json(),
    ).toMatchObject({ coverage: 'excerpt', text: '编辑过' });
    expect(
      (await owner.req('POST', `/projects/${projectId}/docs/${docId}/move`, { space: 'personal' }))
        .statusCode,
    ).toBe(200);
    const moved = await owner.req('GET', `${base}/items/${item.id}/content`);
    expect(moved.json().text).toBeNull();
    expect(moved.json().unavailableReason).toBeTruthy();
    // 丢失原件不会阻止整理条目，但不能重新关联个人原件。
    expect(
      (
        await owner.req('PATCH', `${base}/items/${item.id}`, {
          baseVersion: 1,
          title: '保留引用的旧条目',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await owner.req('PATCH', `${base}/items/${item.id}`, {
          baseVersion: 2,
          resource: { kind: 'document', id: docId },
        })
      ).statusCode,
    ).toBe(422);
  });
  it('并发移动分组不会产生循环', async () => {
    const record = (
      await owner.req('POST', `${p}/workspaces`, { title: '分组并发' })
    ).json<ResearchRecord>();
    const base = `${p}/records/${record.id}`;
    const a = (
      await owner.req('POST', `${base}/items`, { kind: 'group', title: 'A' })
    ).json<ResearchItem>();
    const b = (
      await owner.req('POST', `${base}/items`, { kind: 'group', title: 'B' })
    ).json<ResearchItem>();
    const [one, two] = await Promise.all([
      owner.req('PATCH', `${base}/items/${a.id}`, { baseVersion: 1, parentId: b.id }),
      owner.req('PATCH', `${base}/items/${b.id}`, { baseVersion: 1, parentId: a.id }),
    ]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 422]);
  });
});
