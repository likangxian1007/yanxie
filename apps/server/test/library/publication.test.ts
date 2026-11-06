import { randomUUID } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ulid,
  type AnyProjectEvent,
  type Paper,
  type PaperDetail,
  type PaperPublishInput,
} from '@srh/shared';
import { files, paperPublications, papers, paperNotes } from '../../src/db/schema';
import { withLiveDocument } from '../../src/realtime/collab';
import { ParserUnavailable } from '../../src/modules/library/parser';
import { setLibraryDepsForTest } from '../../src/modules/library/pipeline';
import { waitForQueueIdle } from '../../src/modules/library/queue';
import { toPaper } from '../../src/modules/library/service';
import { libraryDiskPath } from '../../src/modules/library/storage';
import { makeApp, openWs, setupProject, signup, type Session, type TestApp } from '../helpers';
import { tinyPdf } from './util';

let t: TestApp;
let owner: Session;
let member: Session;
let guest: Session;
let outsider: Session;
let pid: string;
const events: AnyProjectEvent[] = [];

beforeAll(async () => {
  t = await makeApp();
  const group = await setupProject(t.app, ['member', 'guest']);
  owner = group.owner;
  [member, guest] = group.others as [Session, Session];
  pid = group.project.id;
  outsider = await signup(t.app);
  t.app.ctx.bus.onEvent((event) => events.push(event));
  setLibraryDepsForTest(t.app.ctx, {
    parser: () => ({
      name: 'grobid',
      url: 'http://parser.test',
      probe: async () => ({ reachable: false, version: null }),
      parse: async () => {
        throw new ParserUnavailable('本地验收');
      },
    }),
  });
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function seed(who = owner, extra: Partial<typeof papers.$inferInsert> = {}) {
  const key = ulid();
  const [row] = await t.db.db
    .insert(papers)
    .values({
      id: `ppr_${key}`,
      ownerUserId: who.user.id,
      citekey: `paper${key.toLowerCase()}`,
      title: `论文 ${key}`,
      source: 'doi',
      status: 'needs_pdf',
      note: 'DO_NOT_PUBLISH_PRIVATE_NOTE',
      createdBy: { kind: 'user', id: who.user.id, name: who.user.name },
      ...extra,
    })
    .returning();
  return toPaper(row!);
}
function input(p: Paper, projectId = pid): PaperPublishInput {
  return { projectId, requestId: randomUUID(), sourceUpdatedAt: p.updatedAt };
}
const publish = (who: Session, p: Paper, body = input(p)) =>
  who.req('POST', `/library/papers/${p.id}/publish`, body);
const teamPath = (id: string) => `/projects/${pid}/library/papers/${id}`;
async function upload() {
  const bytes = tinyPdf([[{ x: 72, y: 720, text: `quartz independent ${ulid()}`, size: 12 }]]);
  const boundary = '----publish-test';
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/library/papers',
    headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(res.statusCode, res.body).toBe(201);
  await waitForQueueIdle(t.app.ctx);
  const id = res.json().paper.id;
  await owner.req('PATCH', `/library/papers/${id}`, { note: 'DO_NOT_PUBLISH_PRIVATE_NOTE' });
  return { paper: (await owner.req('GET', `/library/papers/${id}`)).json<PaperDetail>(), bytes };
}

describe('L10：追加发布', () => {
  it('旧凭据的已发布版本跳过，新增版本另存记录，不覆盖团队正文或标题', async () => {
    const p = await seed();
    const n = (
      await owner.req('POST', `/library/papers/${p.id}/notes`, {
        title: '研究笔记',
        body: '个人第一版',
      })
    ).json();
    const first = await publish(owner, p, {
      ...input(p),
      notes: [{ id: n.id, version: n.version }],
    });
    const target = first.json().paper as Paper;
    const shared = (await member.req('GET', `${teamPath(target.id)}/notes`)).json()[0];
    await withLiveDocument(
      t.app.ctx,
      shared.id,
      { kind: 'user', id: member.user.id, name: member.user.name },
      (d) => d.getText('body').insert(0, '团队补充：'),
    );
    await owner.req('PATCH', teamPath(target.id), { title: '团队标题' });
    const current = (await owner.req('GET', teamPath(target.id))).json<Paper>();
    const body = {
      ...input(p),
      targetPaperId: current.id,
      targetUpdatedAt: current.updatedAt,
      notes: [{ id: n.id, version: n.version }],
    };
    const again = await publish(owner, p, body);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().summary).toMatchObject({ added: { notes: 0 }, skipped: { notes: 1 } });
    await withLiveDocument(
      t.app.ctx,
      n.id,
      { kind: 'user', id: owner.user.id, name: owner.user.name },
      (d) => d.getText('body').insert(0, '个人第二版：'),
    );
    const latest = (await owner.req('POST', `/library/papers/${p.id}/notes/${n.id}/flush`)).json();
    const added = await publish(owner, p, {
      ...body,
      requestId: randomUUID(),
      notes: [{ id: n.id, version: latest.version }],
    });
    expect(added.statusCode, added.body).toBe(201);
    const rows = (await member.req('GET', `${teamPath(target.id)}/notes`)).json();
    expect(rows).toHaveLength(2);
    expect(rows.find((r: { id: string }) => r.id === shared.id).body).toContain('团队补充');
    expect(added.json().paper.title).toBe('团队标题');
    await t.db.db
      .update(paperNotes)
      .set({ deletedAt: new Date() })
      .where(eq(paperNotes.paperId, target.id));
    const repeat = await publish(owner, p, {
      ...body,
      requestId: randomUUID(),
      notes: [{ id: n.id, version: latest.version }],
    });
    expect(repeat.json().summary.added.notes).toBe(0);
    expect((await member.req('GET', `${teamPath(target.id)}/notes`)).json()).toHaveLength(0);
  });
  it('不同请求并发追加同一笔记只新增一次，过期或任意目标被拒绝', async () => {
    const p = await seed(),
      target = (await publish(owner, p)).json().paper as Paper;
    const n = (
      await owner.req('POST', `/library/papers/${p.id}/notes`, { title: '新的笔记', body: 'new' })
    ).json();
    const body = {
      ...input(p),
      targetPaperId: target.id,
      targetUpdatedAt: target.updatedAt,
      notes: [{ id: n.id, version: 1 }],
    };
    const results = await Promise.all([
      publish(owner, p, body),
      publish(owner, p, { ...body, requestId: randomUUID() }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(results.map((r) => r.json().summary.added.notes).sort()).toEqual([0, 1]);
    expect(
      (await publish(owner, p, { ...body, requestId: randomUUID(), targetPaperId: 'ppr_unknown' }))
        .statusCode,
    ).toBe(409);
    await owner.req('PATCH', teamPath(target.id), { title: '改名' });
    expect((await publish(owner, p, { ...body, requestId: randomUUID() })).statusCode).toBe(409);
  });
  it('候选列表只向原件所有者与目标项目写入成员开放', async () => {
    const p = await seed(),
      target = (await publish(owner, p)).json().paper as Paper;
    const endpoint = `/library/papers/${p.id}/publish-targets?projectId=${pid}`;
    const candidates = await owner.req('GET', endpoint);
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json()[0].paper.id).toBe(target.id);
    expect((await member.req('GET', endpoint)).statusCode).toBe(404);
    expect((await outsider.req('GET', endpoint)).statusCode).toBe(404);
    expect((await guest.req('GET', endpoint)).statusCode).toBe(403);
  });
});
describe('L07：独立副本、原子发布与重试', () => {
  it('复制 PDF 和解析段落，不复制笔记；双向修改独立，删除个人原件后团队仍可下载、检索与定位', async () => {
    const { paper: source, bytes } = await upload();
    const before = events.length;
    const res = await publish(owner, source);
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json<{ paper: Paper }>().paper;
    expect(copy.id).not.toBe(source.id);
    expect(copy.fileId).not.toBe(source.fileId);
    expect(copy).toMatchObject({ projectId: pid, ownerUserId: null, note: '', noteVersion: 1 });
    const detail = (await member.req('GET', teamPath(copy.id))).json<PaperDetail>();
    expect(detail.structure?.chunks.length).toBeGreaterThan(0);
    expect(detail.structure?.chunks.map((c) => c.id)).toEqual(
      source.structure!.chunks.map((c) => `${copy.id}:${c.seq}`),
    );
    expect(detail.structure?.chunks.map((c) => c.boxes)).toEqual(
      source.structure?.chunks.map((c) => c.boxes),
    );
    expect(JSON.stringify(events.slice(before))).not.toContain('DO_NOT_PUBLISH_PRIVATE_NOTE');
    expect(JSON.stringify(events.slice(before))).not.toContain(source.id);
    expect(JSON.stringify(events.slice(before))).not.toContain(source.fileId!);
    await owner.req('PATCH', `/library/papers/${source.id}`, { title: '个人新标题' });
    expect((await member.req('GET', teamPath(copy.id))).json().title).toBe(source.title);
    await member.req('PATCH', teamPath(copy.id), {
      title: '团队新标题',
      baseTitleVersion: copy.titleVersion,
    });
    expect((await owner.req('GET', `/library/papers/${source.id}`)).json().title).toBe(
      '个人新标题',
    );
    expect((await owner.req('DELETE', `/library/papers/${source.id}`)).statusCode).toBe(204);
    const pdf = await t.app.inject({
      method: 'GET',
      url: `/api/v1${teamPath(copy.id)}/pdf`,
      headers: { cookie: member.cookie },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload).toEqual(bytes);
    const hits = await member.req(
      'GET',
      `/projects/${pid}/library/search?q=quartz&paperId=${copy.id}`,
    );
    expect(hits.statusCode).toBe(200);
    expect(hits.json().length).toBeGreaterThan(0);
    expect(hits.json()[0]).toMatchObject({ paperId: copy.id });
    expect((await member.req('GET', `/library/papers/${source.id}`)).statusCode).toBe(404);
    expect((await member.req('GET', `${teamPath(copy.id)}/bibtex`)).body).toContain(copy.citekey);
  }, 30_000);

  it('只有元数据也可发布；两份没有 DOI 的不同论文不会相互阻塞', async () => {
    for (let n = 0; n < 2; n++) {
      const source = await seed();
      const res = await publish(owner, source);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().paper).toMatchObject({ fileId: null, status: 'needs_pdf', note: '' });
    }
  });

  it('同一请求并发重试只复制一次；删除个人原件后仍能取回原发布结果', async () => {
    const source = await seed();
    const body = input(source);
    const before = events.length;
    const results = await Promise.all([publish(owner, source, body), publish(owner, source, body)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(results[0]!.json().paper.id).toBe(results[1]!.json().paper.id);
    expect(events.slice(before).filter((e) => e.type === 'paper.created')).toHaveLength(1);
    await owner.req('DELETE', `/library/papers/${source.id}`);
    const again = await publish(owner, source, body);
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
  });

  it('不同请求同时发布同一来源时，一次成功，另一次明确提示已有论文', async () => {
    const source = await seed();
    const results = await Promise.all([publish(owner, source), publish(owner, source)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(
      results.find((r) => r.statusCode === 409)!.json().error.details.existingPaperId,
    ).toBeTruthy();
  });

  it('同 DOI 候选（包括已归档）提示并停止，不覆盖团队内容', async () => {
    const doi = `10.1000/${ulid()}`;
    const first = await seed(owner, { doi });
    const copy = (await publish(owner, first)).json().paper as Paper;
    await owner.req('PATCH', teamPath(copy.id), { title: '团队维护的标题', archived: true });
    const second = await seed(member, { doi });
    const res = await publish(member, second);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.existingPaperId).toBe(copy.id);
    expect((await member.req('GET', teamPath(copy.id))).json().title).toBe('团队维护的标题');
  });

  it('同 PDF 的另一个个人副本也不能重复发布', async () => {
    const { paper: source } = await upload();
    const first = await publish(owner, source);
    expect(first.statusCode).toBe(201);
    const [row] = await t.db.db.select().from(papers).where(eq(papers.id, source.id));
    const second = await seed(member, { pdfSha256: row!.pdfSha256 });
    expect((await publish(member, second)).statusCode).toBe(409);
  }, 30_000);

  it('发布编号不能复用于另一来源；团队副本删除后重试也不会偷偷重建', async () => {
    const source = await seed();
    const body = input(source);
    const copy = (await publish(owner, source, body)).json().paper;
    expect((await publish(owner, await seed(), body)).statusCode).toBe(409);
    await owner.req('DELETE', teamPath(copy.id));
    expect((await publish(owner, source, body)).statusCode).toBe(409);
  });

  it('未登录、跨账号、非项目成员、访客均不能发布', async () => {
    const source = await seed();
    const body = input(source);
    const anonymous = await t.app.inject({
      method: 'POST',
      url: `/api/v1/library/papers/${source.id}/publish`,
      payload: body,
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await publish(member, source, body)).statusCode).toBe(404);
    expect((await publish(outsider, await seed(outsider))).statusCode).toBe(404);
    expect((await publish(guest, await seed(guest))).statusCode).toBe(403);
    expect((await outsider.req('GET', `/projects/${pid}/library/papers`)).statusCode).toBe(404);
  });

  it('拒绝额外私人字段、过期预览、处理中或已归档论文', async () => {
    const source = await seed();
    expect(
      (
        await owner.req('POST', `/library/papers/${source.id}/publish`, {
          ...input(source),
          note: '不应接受',
        })
      ).statusCode,
    ).toBe(422);
    await owner.req('PATCH', `/library/papers/${source.id}`, { title: '已改动' });
    expect((await publish(owner, source)).statusCode).toBe(409);
    expect((await publish(owner, await seed(owner, { status: 'parsing' }))).statusCode).toBe(409);
    expect((await publish(owner, await seed(owner, { archivedAt: new Date() }))).statusCode).toBe(
      409,
    );
  });

  it('PDF 缺失时发布失败，不留下团队论文或发布凭据', async () => {
    const { paper: source } = await upload();
    const [file] = await t.db.db.select().from(files).where(eq(files.id, source.fileId!));
    await unlink(
      libraryDiskPath(t.app.ctx, { kind: 'personal', ownerUserId: owner.user.id }, file!.path),
    );
    const before = events.length;
    expect((await publish(owner, source)).statusCode).toBe(409);
    expect(
      await t.db.db
        .select()
        .from(paperPublications)
        .where(eq(paperPublications.sourcePaperId, source.id)),
    ).toHaveLength(0);
    expect(events.length).toBe(before);
  }, 30_000);

  it('文件写完后事务失败也会回滚记录、清理本次 PDF，且不广播事件', async () => {
    const { paper: source } = await upload();
    const diskRoot = libraryDiskPath(t.app.ctx, pid, 'library');
    const beforeFiles = (await readdir(diskRoot, { recursive: true }))
      .filter((s) => s.endsWith('.pdf'))
      .sort();
    const before = events.length;
    const spy = vi.spyOn(t.app.ctx.bus, 'record').mockRejectedValueOnce(new Error('模拟事务失败'));
    try {
      expect((await publish(owner, source)).statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(events.length).toBe(before);
    expect(
      await t.db.db
        .select()
        .from(paperPublications)
        .where(eq(paperPublications.sourcePaperId, source.id)),
    ).toHaveLength(0);
    expect(
      (await readdir(diskRoot, { recursive: true })).filter((s) => s.endsWith('.pdf')).sort(),
    ).toEqual(beforeFiles);
  }, 30_000);
});

describe('L11：并发字段更新与实时成员权限', () => {
  it('两人同时改不同字段均保留；同字段旧版本返回 409，访客也可维护论文信息', async () => {
    const copy = (await publish(owner, await seed())).json().paper as Paper;
    const results = await Promise.all([
      member.req('PATCH', teamPath(copy.id), {
        title: '成员改标题',
        baseTitleVersion: copy.titleVersion,
      }),
      guest.req('PATCH', teamPath(copy.id), {
        tags: ['团队标签'],
        baseTagsVersion: copy.tagsVersion,
      }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const state = (await member.req('GET', teamPath(copy.id))).json<Paper>();
    expect(state).toMatchObject({
      title: '成员改标题',
      tags: ['团队标签'],
      titleVersion: 2,
      tagsVersion: 2,
    });
    const stale = await guest.req('PATCH', teamPath(copy.id), {
      title: '旧页面覆盖',
      baseTitleVersion: copy.titleVersion,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details.current.title).toBe('成员改标题');
    expect((await guest.req('PATCH', teamPath(copy.id), { archived: true })).statusCode).toBe(403);
    expect((await outsider.req('PATCH', teamPath(copy.id), { title: '越权' })).statusCode).toBe(
      404,
    );
  });

  it('两人同时改同一字段时只有一个成功', async () => {
    const copy = (await publish(owner, await seed())).json().paper as Paper;
    const results = await Promise.all([
      owner.req('PATCH', teamPath(copy.id), { title: 'A', baseTitleVersion: 1 }),
      member.req('PATCH', teamPath(copy.id), { title: 'B', baseTitleVersion: 1 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('成员收到发布/修改事件，断线后可补发；非成员订阅被拒绝', async () => {
    const live = await openWs(t.app, member.cookie);
    const denied = await openWs(t.app, outsider.cookie);
    try {
      live.ws.send(JSON.stringify({ op: 'subscribe', projectId: pid }));
      const frame = await live.waitFor((f) => f.op === 'subscribed');
      const cursor = frame.op === 'subscribed' ? frame.latestSeq : 0;
      denied.ws.send(JSON.stringify({ op: 'subscribe', projectId: pid }));
      await denied.waitFor((f) => f.op === 'error' && f.code === 'forbidden');
      const copy = (await publish(owner, await seed())).json().paper as Paper;
      await live.waitFor(
        (f) =>
          f.op === 'event' && f.event.type === 'paper.created' && f.event.payload.id === copy.id,
      );
      live.ws.close();
      await owner.req('PATCH', teamPath(copy.id), {
        title: '断线期间更新',
        baseTitleVersion: copy.titleVersion,
      });
      const restored = await openWs(t.app, member.cookie);
      try {
        restored.ws.send(
          JSON.stringify({ op: 'subscribe', projectId: pid, afterSeq: cursor, replay: true }),
        );
        await restored.waitFor(
          (f) =>
            f.op === 'event' &&
            f.event.type === 'paper.updated' &&
            f.event.payload.title === '断线期间更新',
        );
      } finally {
        restored.ws.close();
      }
    } finally {
      live.ws.close();
      denied.ws.close();
    }
  });

  it('移出成员后关闭已有连接，HTTP 与重新订阅均失去项目权限', async () => {
    const group = await setupProject(t.app, ['guest']);
    const removed = group.others[0]!;
    const live = await openWs(t.app, removed.cookie);
    live.ws.send(JSON.stringify({ op: 'subscribe', projectId: group.project.id }));
    await live.waitFor((f) => f.op === 'subscribed');
    const closed = new Promise<number>((resolve) => live.ws.once('close', (code) => resolve(code)));
    expect(
      (await group.owner.req('DELETE', `/projects/${group.project.id}/members/${removed.user.id}`))
        .statusCode,
    ).toBe(204);
    expect(await closed).toBe(4403);
    expect(
      (await removed.req('GET', `/projects/${group.project.id}/library/papers`)).statusCode,
    ).toBe(404);
    const retry = await openWs(t.app, removed.cookie);
    try {
      retry.ws.send(JSON.stringify({ op: 'subscribe', projectId: group.project.id }));
      await retry.waitFor((f) => f.op === 'error' && f.code === 'forbidden');
    } finally {
      retry.ws.close();
    }
  });
});
