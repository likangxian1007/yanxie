import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  ulid,
  newId,
  type Paper,
  type PaperQaSession,
  type PaperQaTurn,
  type PaperQaPublishPreview,
  type PaperQaSource,
} from '@srh/shared';
import {
  files,
  papers,
  paperChunks,
  paperQaTurns,
  paperQaSessions,
  paperQaRevisions,
  projectMembers,
} from '../../src/db/schema';
import { libraryDiskPath } from '../../src/modules/library/storage';
import { toPaper } from '../../src/modules/library/service';
import { invalidateIndex } from '../../src/modules/library/search';
import { setLibraryLlmForTest } from '../../src/modules/library/llm';
import {
  waitForQaJobs,
  setQaDeadlineForTest,
  recoverQaJobs,
  stopQaJobs,
} from '../../src/modules/library/qa-jobs';
import { sanitizeQaPublication } from '../../src/modules/library/qa-publication';
import { withLiveDocument, documentConnections } from '../../src/realtime/collab';
import type { LlmClient } from '../../src/agents/llm/client';
import { makeApp, setupProject, signup, sleep, type Session, type TestApp } from '../helpers';
import { tinyPdf } from './util';

let t: TestApp,
  owner: Session,
  member: Session,
  guest: Session,
  outsider: Session,
  pid: string,
  url: string;
let mode: 'ok' | 'hang' | 'fail' = 'ok',
  calls: { model: string; messages: { content: string }[]; stream?: boolean }[] = [];
const fake: LlmClient = {
  model: 'mock',
  reasoningModel: 'mock',
  client: {
    chat: {
      completions: {
        async create(body: (typeof calls)[number]) {
          calls.push(body);
          if (!body.stream) return { choices: [{ message: { content: 'attention, experiment' } }] };
          const question = body.messages.at(-1)!.content.split('问题：').at(-1)!;
          return (async function* () {
            yield { choices: [{ delta: { content: `回答 ${question} [p.1 ¶1]` } }] };
            if (mode === 'hang') await new Promise(() => undefined);
            if (mode === 'fail') throw new Error('unsafe upstream secret');
            await sleep(30);
            yield { choices: [{ delta: { content: ' 完成。' } }] };
          })();
        },
      },
    },
  } as unknown as LlmClient['client'],
};
beforeAll(async () => {
  t = await makeApp();
  const group = await setupProject(t.app, ['member', 'guest']);
  owner = group.owner;
  [member, guest] = group.others as [Session, Session];
  pid = group.project.id;
  outsider = await signup(t.app);
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/collab`;
}, 60000);
beforeEach(async () => {
  await stopQaJobs(t.app.ctx);
  mode = 'ok';
  calls = [];
  setLibraryLlmForTest(t.app.ctx, fake);
  setQaDeadlineForTest(t.app.ctx, 5000);
});
afterAll(async () => {
  await t?.close();
});
const actor = (s = owner) => ({ kind: 'user' as const, id: s.user.id, name: s.user.name });
async function seed(team = false) {
  const id = `ppr_${ulid()}`,
    fileId = newId('file'),
    scope = team ? pid : { kind: 'personal' as const, ownerUserId: owner.user.id },
    ownership = team ? { projectId: pid } : { ownerUserId: owner.user.id };
  const bytes = tinyPdf([[{ x: 72, y: 720, size: 12, text: `Attention experiment ${id}` }]]),
    path = `library/${fileId}/test.pdf`,
    disk = libraryDiskPath(t.app.ctx, scope, path);
  await mkdir(dirname(disk), { recursive: true });
  await writeFile(disk, bytes);
  await t.db.db.insert(files).values({
    id: fileId,
    ...ownership,
    name: 'test.pdf',
    path,
    mime: 'application/pdf',
    size: bytes.length,
    uploadedBy: actor(),
  });
  const [row] = await t.db.db
    .insert(papers)
    .values({
      id,
      ...ownership,
      title: '问答测试论文',
      citekey: `test${ulid()}`,
      source: 'upload',
      status: 'ready',
      fileId,
      pdfSha256: createHash('sha256').update(bytes).digest('hex'),
      pageCount: 1,
      chunkCount: 1,
      structure: {
        pages: [{ width: 612, height: 792 }],
        sections: [],
        formulas: [],
        figures: [],
        references: [],
        macros: {},
      },
      createdBy: actor(),
    })
    .returning();
  await t.db.db.insert(paperChunks).values({
    id: `${id}:0`,
    paperId: id,
    projectId: team ? pid : null,
    seq: 0,
    kind: 'paragraph',
    page: 1,
    para: 1,
    text: 'Attention experiment demonstrates robust results based on this original evidence.',
    boxes: [{ page: 1, x: 72, y: 60, w: 250, h: 14 }],
  });
  invalidateIndex(t.app.ctx, scope);
  return toPaper(row!);
}
const base = (p: Paper) =>
  `${p.projectId ? `/projects/${p.projectId}` : ''}/library/papers/${p.id}`;
async function session(p: Paper, who = owner) {
  const r = await who.req('POST', `${base(p)}/qa/sessions`, { title: '实验问答' });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<PaperQaSession>();
}
async function ask(
  p: Paper,
  s: PaperQaSession,
  question = 'attention experiment',
  options: Record<string, unknown> = {},
  who = owner,
) {
  const r = await who.req('POST', `${base(p)}/qa/sessions/${s.id}/turns`, {
    requestId: randomUUID(),
    question,
    ...options,
  });
  expect(r.statusCode, r.body).toBe(202);
  return r.json<PaperQaTurn>();
}
async function turns(p: Paper, s: PaperQaSession, who = owner) {
  const r = await who.req('GET', `${base(p)}/qa/sessions/${s.id}/turns`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<PaperQaTurn[]>();
}
async function done(
  p: Paper,
  s: PaperQaSession,
  question = 'attention experiment',
  options: Record<string, unknown> = {},
) {
  const r = await ask(p, s, question, options);
  await waitForQaJobs(t.app.ctx);
  return (await turns(p, s)).find((t) => t.id === r.id)!;
}
async function edit(turn: PaperQaTurn, question: string, answer: string, who = owner) {
  await withLiveDocument(t.app.ctx, turn.id, actor(who), (d) => {
    for (const [key, value] of [
      ['question', question],
      ['answer', answer],
    ]) {
      const text = d.getText(key!);
      text.delete(0, text.length);
      text.insert(0, value!);
    }
  });
}
const selection = (turn: PaperQaTurn, extra: Record<string, unknown> = {}) => ({
  id: turn.id,
  version: turn.version,
  unsharedSources: 'mark',
  allowMissingContext: false,
  ...extra,
});
const publish = async (p: Paper, qa: ReturnType<typeof selection>[]) => {
  let selected = qa;
  if (qa.length) {
    const pre = await preview(p, qa);
    if (pre.statusCode !== 200) return pre;
    const rows = pre.json<PaperQaPublishPreview>().turns;
    selected = qa.map((q) => ({ ...q, previewHash: rows.find((t) => t.id === q.id)!.previewHash }));
  }
  return owner.req('POST', `${base(p)}/publish`, {
    projectId: pid,
    requestId: randomUUID(),
    sourceUpdatedAt: p.updatedAt,
    qa: selected,
  });
};
const preview = (p: Paper, qa: unknown[]) =>
  owner.req('POST', `${base(p)}/qa/publication-preview`, { projectId: pid, selections: qa });
async function appendQa(p: Paper, target: Paper, rows: PaperQaTurn[], allow = false) {
  const selections = rows.map((r) => selection(r, { allowMissingContext: allow }));
  const pre = await owner.req('POST', `${base(p)}/qa/publication-preview`, {
    projectId: pid,
    targetPaperId: target.id,
    selections,
  });
  expect(pre.statusCode, pre.body).toBe(200);
  const qa = selections.map((q) => ({
    ...q,
    previewHash: pre.json<PaperQaPublishPreview>().turns.find((r) => r.id === q.id)!.previewHash,
  }));
  const body = {
    projectId: pid,
    targetPaperId: target.id,
    targetUpdatedAt: target.updatedAt,
    sourceUpdatedAt: p.updatedAt,
    requestId: randomUUID(),
    qa,
  };
  return { response: await owner.req('POST', `${base(p)}/publish`, body), body, pre };
}
describe('L10 与选句提问', () => {
  it('选句与问题分别保存并传给模型，刷新可读；错误文件、页码和超长选句被拒绝', async () => {
    const p = await seed(),
      s = await session(p),
      quote = { fileId: p.fileId!, page: 1, text: 'SELECTED original result 42' };
    await done(p, s, 'Explain this sentence', { selection: quote });
    const row = (await turns(p, s))[0]!;
    expect(row.question).toBe('Explain this sentence');
    expect(row.selection).toMatchObject({ ...quote, status: 'available' });
    expect(calls.find((c) => c.stream)?.messages.at(-1)?.content).toContain(quote.text);
    for (const selection of [
      { ...quote, fileId: 'other' },
      { ...quote, page: 2 },
      { ...quote, text: 'a'.repeat(4001) },
    ]) {
      const r = await owner.req('POST', `${base(p)}/qa/sessions/${s.id}/turns`, {
        requestId: randomUUID(),
        question: 'explain',
        selection,
      });
      expect([409, 422]).toContain(r.statusCode);
    }
    await t.db.db.update(papers).set({ pdfSha256: 'changed' }).where(eq(papers.id, p.id));
    expect((await turns(p, s))[0]!.selection?.status).toBe('changed');
  });
  it('没有解析正文时也能解释主动选句，未附选句仍拒绝普通单篇问答', async () => {
    const p = await seed(),
      s = await session(p);
    await t.db.db.delete(paperChunks).where(eq(paperChunks.paperId, p.id));
    await t.db.db
      .update(papers)
      .set({ status: 'failed', structure: null })
      .where(eq(papers.id, p.id));
    invalidateIndex(t.app.ctx, { kind: 'personal', ownerUserId: owner.user.id });
    const r = await done(p, s, 'Explain this', {
      selection: { fileId: p.fileId!, page: 1, text: 'the explicit sentence' },
    });
    expect(r.status).toBe('done');
    expect(calls.some((c) => c.stream)).toBe(true);
    expect(
      (
        await owner.req('POST', `${base(p)}/qa/sessions/${s.id}/turns`, {
          requestId: randomUUID(),
          question: 'explain',
        })
      ).statusCode,
    ).toBe(409);
  });
  it('追加问答使用项目 PDF、保留团队编辑；重复版本跳过，同请求重试复用结果', async () => {
    const p = await seed(),
      s = await session(p),
      a = await done(p, s);
    const first = await publish(p, [selection(a)]),
      target = first.json().paper as Paper;
    const sharedSession = (await owner.req('GET', `${base(target)}/qa/sessions`)).json()[0];
    const shared = (await turns(target, sharedSession))[0]!;
    await edit(shared, '团队问题', 'TEAM_EDIT_MUST_REMAIN', member);
    const b = await done(p, s, 'attention NEW', {
      selection: { fileId: p.fileId!, page: 1, text: 'selected evidence' },
    });
    const added = await appendQa(p, target, [b]);
    expect(added.response.statusCode, added.response.body).toBe(201);
    expect(added.response.json().summary).toMatchObject({ mode: 'appended', added: { qa: 1 } });
    expect(added.pre.json().turns[0].selection.fileId).toBe(target.fileId);
    const allSessions = (await owner.req('GET', `${base(target)}/qa/sessions`)).json<
      PaperQaSession[]
    >();
    const all = (await Promise.all(allSessions.map((s) => turns(target, s)))).flat();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === shared.id)!.answer).toBe('TEAM_EDIT_MUST_REMAIN');
    expect(all.find((r) => r.id !== shared.id)!.selection?.fileId).toBe(target.fileId);
    expect((await owner.req('POST', `${base(p)}/publish`, added.body)).json()).toMatchObject({
      replayed: true,
      summary: { added: { qa: 1 } },
    });
    const again = await appendQa(p, target, [b]);
    expect(again.response.json().summary).toMatchObject({ added: { qa: 0 }, skipped: { qa: 1 } });
  });
  it('章节长段落完整保存来源，追加发布仍能映射同 PDF 的团队引用', async () => {
    const p = await seed();
    const text =
      'Attention experiments demonstrate reproducible results under controlled conditions. '.repeat(
        35,
      ) + 'The final contribution explains the remaining limitations.';
    await t.db.db
      .update(paperChunks)
      .set({ text, sectionPath: '1 Introduction' })
      .where(eq(paperChunks.paperId, p.id));
    invalidateIndex(t.app.ctx, { kind: 'personal', ownerUserId: owner.user.id });
    const published = await publish(p, []);
    expect(published.statusCode, published.body).toBe(201);
    const s = await session(p),
      turn = await done(p, s, '总结引言');
    expect(turn.sources[0]?.quote).toBe(text);
    expect(
      calls
        .filter((c) => c.stream)
        .at(-1)
        ?.messages.at(-1)?.content,
    ).toContain('final contribution');
    const target = published.json().paper as Paper;
    const appended = await appendQa(p, target, [turn]);
    expect(appended.response.statusCode, appended.response.body).toBe(201);
    expect(appended.pre.json().turns[0].sources[0]).toMatchObject({
      paperId: target.id,
      fileId: target.fileId,
      status: 'available',
      quote: text,
    });
  });
  it('PDF 版本不同的问答追加不能错指团队 PDF，选句预览明确未共享', async () => {
    const p = await seed(),
      s = await session(p),
      a = await done(p, s, 'attention', {
        selection: { fileId: p.fileId!, page: 1, text: 'quoted original' },
      });
    const target = (await publish(p, [])).json().paper as Paper;
    await t.db.db.update(papers).set({ pdfSha256: 'other' }).where(eq(papers.id, target.id));
    const added = await appendQa(p, target, [a]);
    expect(added.response.statusCode, added.response.body).toBe(201);
    expect(added.pre.json().turns[0]).toMatchObject({
      selection: { fileId: null, status: 'unshared' },
    });
    expect(
      added.pre
        .json()
        .turns[0].sources.every((r: PaperQaSource) => r.status === 'unshared' && r.fileId === null),
    ).toBe(true);
  });
  it('已发布前文不重新复制，追加依赖它的新轮次需明确确认缺少冻结上下文', async () => {
    const p = await seed(),
      s = await session(p),
      a = await done(p, s),
      b = await done(p, s, 'attention dependent', { contextTurnIds: [a.id] });
    const target = (await publish(p, [selection(a)])).json().paper as Paper;
    const denied = await appendQa(p, target, [a, b]);
    expect(denied.response.statusCode).toBe(422);
    expect(
      denied.pre.json().turns.find((r: PaperQaTurn) => r.id === b.id).missingContext,
    ).toHaveLength(1);
    const allowed = await appendQa(p, target, [a, b], true);
    expect(allowed.response.statusCode, allowed.response.body).toBe(201);
    expect(allowed.response.json().summary).toMatchObject({ added: { qa: 1 }, skipped: { qa: 1 } });
  });
});
const wait = (fn: () => boolean) =>
  vi.waitFor(() => expect(fn()).toBe(true), { timeout: 7000, interval: 25 });
function connect(id: string, who: Session) {
  class CookieSocket extends WebSocket {
    constructor(address: string | URL) {
      super(address, { headers: { cookie: who.cookie } });
    }
  }
  const doc = new Y.Doc(),
    socket = new HocuspocusProviderWebsocket({
      url: `${url}/${id}`,
      WebSocketPolyfill: CookieSocket,
    } as ConstructorParameters<typeof HocuspocusProviderWebsocket>[0]);
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: id,
    document: doc,
    token: 'cookie',
  });
  provider.attach();
  return {
    doc,
    provider,
    close() {
      provider.destroy();
      socket.destroy();
      doc.destroy();
    },
  };
}

describe('L05 保存问答与任务', () => {
  it('重新读取得到同一轮次、原始输出与来源；私人问答和鉴权隔离', async () => {
    const p = await seed(),
      s = await session(p),
      r = await done(p, s);
    expect(r).toMatchObject({
      status: 'done',
      originalQuestion: 'attention experiment',
      answer: '回答 attention experiment [p.1 ¶1] 完成。',
      context: [],
    });
    expect(r.originalAnswer).toBe(r.answer);
    expect(r.sources[0]).toMatchObject({
      paperId: p.id,
      fileId: p.fileId,
      status: 'available',
      page: 1,
      para: 1,
    });
    expect((await turns(p, s))[0]?.id).toBe(r.id);
    expect((await member.req('GET', `${base(p)}/qa/sessions`)).statusCode).toBe(404);
    expect((await member.req('POST', `${base(p)}/qa/turns/${r.id}/flush`)).statusCode).toBe(404);
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/v1${base(p)}/qa/sessions` })).statusCode,
    ).toBe(401);
    expect(
      (await owner.req('POST', `${base(p)}/qa/sessions`, { title: '', extra: 1 })).statusCode,
    ).toBe(422);
    expect(
      (
        await owner.req('POST', `${base(p)}/qa/sessions/${s.id}/turns`, {
          question: 'x',
          requestId: 'bad',
        })
      ).statusCode,
    ).toBe(422);
  });
  it('重复请求只生成一次，重复编号用于其他问题被拒绝；模型下线不妨碍重试查询', async () => {
    const p = await seed(),
      s = await session(p),
      requestId = randomUUID();
    const [a, b] = await Promise.all([
      ask(p, s, 'attention', { requestId }),
      ask(p, s, 'attention', { requestId }),
    ]);
    expect(a.id).toBe(b.id);
    await waitForQaJobs(t.app.ctx);
    expect(calls.filter((c) => c.stream)).toHaveLength(1);
    setLibraryLlmForTest(t.app.ctx, null);
    expect((await ask(p, s, 'attention', { requestId })).id).toBe(a.id);
    expect(
      (
        await owner.req('POST', `${base(p)}/qa/sessions/${s.id}/turns`, {
          requestId,
          question: 'changed',
        })
      ).statusCode,
    ).toBe(409);
  });
  it('上下文冻结生成时的版本，后来编辑不会改写该轮依据', async () => {
    const p = await seed(),
      s = await session(p),
      a = await done(p, s),
      b = await done(p, s, 'attention followup', { contextTurnIds: [a.id] });
    await edit(a, 'changed question', 'changed answer');
    const latest = (await turns(p, s)).find((x) => x.id === b.id)!;
    expect(latest.context).toEqual([
      { turnId: a.id, version: 1, question: a.question, answer: a.answer },
    ]);
    expect(
      calls
        .filter((c) => c.stream)
        .at(-1)
        ?.messages.at(-1)?.content,
    ).toContain(a.answer);
    const other = await session(p);
    expect(
      (
        await owner.req('POST', `${base(p)}/qa/sessions/${other.id}/turns`, {
          requestId: randomUUID(),
          question: 'attention',
          contextTurnIds: [a.id],
        })
      ).statusCode,
    ).toBe(422);
  });
  it('两个成员并发生成互不串答，访客可读但不可调用模型', async () => {
    const p = await seed(true),
      s = await session(p);
    const [a, b] = await Promise.all([
      ask(p, s, 'attention AAA'),
      ask(p, s, 'attention BBB', {}, member),
    ]);
    await waitForQaJobs(t.app.ctx);
    const rows = await turns(p, s, guest);
    expect(rows.find((r) => r.id === a.id)?.answer).toContain('AAA');
    expect(rows.find((r) => r.id === a.id)?.answer).not.toContain('BBB');
    expect(rows.find((r) => r.id === b.id)?.answer).toContain('BBB');
    expect(a.generationId).not.toBe(b.generationId);
    expect(
      (
        await guest.req('POST', `${base(p)}/qa/sessions/${s.id}/turns`, {
          requestId: randomUUID(),
          question: 'attention',
        })
      ).statusCode,
    ).toBe(403);
    expect((await outsider.req('GET', `${base(p)}/qa/sessions`)).statusCode).toBe(404);
  });
  it('停止与超时保存部分正文，永远不把不完整输出当成 done', async () => {
    mode = 'hang';
    const p = await seed(),
      s = await session(p),
      a = await ask(p, s);
    await vi.waitFor(async () => expect((await turns(p, s))[0]?.answer).toContain('回答'));
    const stopped = await owner.req('POST', `${base(p)}/qa/turns/${a.id}/stop`);
    expect(stopped.json<PaperQaTurn>()).toMatchObject({
      status: 'cancelled',
      answer: expect.stringContaining('回答'),
    });
    setQaDeadlineForTest(t.app.ctx, 150);
    const b = await ask(p, s, 'attention timeout');
    await waitForQaJobs(t.app.ctx);
    expect((await turns(p, s)).find((x) => x.id === b.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('超时'),
    });
  });
  it('上游异常不泄露报错，服务停止保留部分回答；启动恢复标记中断', async () => {
    mode = 'fail';
    const p = await seed(),
      s = await session(p),
      a = await done(p, s);
    expect(a.status).toBe('failed');
    expect(a.error).not.toContain('secret');
    mode = 'hang';
    const b = await ask(p, s);
    await vi.waitFor(async () =>
      expect((await turns(p, s)).find((x) => x.id === b.id)?.answer).toContain('回答'),
    );
    await stopQaJobs(t.app.ctx);
    expect((await turns(p, s)).find((x) => x.id === b.id)?.status).toBe('interrupted');
    await t.db.db
      .update(paperQaTurns)
      .set({ status: 'generating' })
      .where(eq(paperQaTurns.id, a.id));
    await recoverQaJobs(t.app.ctx);
    expect((await turns(p, s)).find((x) => x.id === a.id)?.status).toBe('interrupted');
  });
  it('会话重命名冲突和删除生效，晚到任务不能复活已删会话', async () => {
    const p = await seed(),
      s = await session(p);
    expect(
      (
        await owner.req('PATCH', `${base(p)}/qa/sessions/${s.id}`, {
          title: '新名称',
          baseVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await owner.req('PATCH', `${base(p)}/qa/sessions/${s.id}`, {
          title: '旧写入',
          baseVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    mode = 'hang';
    await ask(p, s);
    expect(
      (await owner.req('POST', `${base(p)}/qa/sessions/${s.id}/trash`, { baseVersion: 2 }))
        .statusCode,
    ).toBe(204);
    await waitForQaJobs(t.app.ctx);
    expect((await owner.req('GET', `${base(p)}/qa/sessions/${s.id}/turns`)).statusCode).toBe(404);
    const [row] = await t.db.db.select().from(paperQaSessions).where(eq(paperQaSessions.id, s.id));
    expect(row?.deletedAt).not.toBeNull();
  });
  it('PDF 被替换或删除后保留引用快照，但定位状态失效', async () => {
    const p = await seed(),
      s = await session(p);
    await done(p, s);
    await t.db.db.update(papers).set({ pdfSha256: 'new-version' }).where(eq(papers.id, p.id));
    expect((await turns(p, s))[0]?.sources[0]?.status).toBe('changed');
  });
  it('提供问答制作独立个人说明稿，保留版本和作者说明', async () => {
    const p = await seed(),
      s = await session(p),
      a = await done(p, s);
    const r = await owner.req('POST', `${base(p)}/qa/turns/${a.id}/brief`, {
      title: '团队解释',
      sourceVersion: a.version,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      kind: 'brief',
      body: expect.stringContaining('问答版本：v1'),
    });
    expect((await member.req('GET', `${base(p)}/notes`)).statusCode).toBe(404);
  });
});
describe('L09 选择发布', () => {
  it('必须提交预览指纹，预览后来源变动要求重新预览；相同发布请求重试复用副本', async () => {
    const p = await seed(),
      s = await session(p),
      a = await done(p, s);
    const input = {
      projectId: pid,
      requestId: randomUUID(),
      sourceUpdatedAt: p.updatedAt,
      qa: [selection(a)],
    };
    expect((await owner.req('POST', `${base(p)}/publish`, input)).statusCode).toBe(409);
    const pr = (await preview(p, input.qa)).json<PaperQaPublishPreview>();
    const withHash = { ...input, qa: [{ ...selection(a), previewHash: pr.turns[0]!.previewHash }] };
    await t.db.db.update(paperQaTurns).set({ sources: [] }).where(eq(paperQaTurns.id, a.id));
    expect((await owner.req('POST', `${base(p)}/publish`, withHash)).statusCode).toBe(409);
    const refreshed = (await preview(p, input.qa)).json<PaperQaPublishPreview>();
    withHash.qa[0]!.previewHash = refreshed.turns[0]!.previewHash;
    const first = await owner.req('POST', `${base(p)}/publish`, withHash);
    expect(first.statusCode, first.body).toBe(201);
    expect((await owner.req('DELETE', base(p))).statusCode).toBe(204);
    const second = await owner.req('POST', `${base(p)}/publish`, withHash);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({
      replayed: true,
      paper: { id: first.json<{ paper: Paper }>().paper.id },
    });
  });
  it('只复制选中的公开版本，重新编号并指向团队 PDF，不带原始私密正文、检索上下文和旧版本', async () => {
    const p = await seed(),
      s = await session(p),
      a = await done(p, s, 'attention PRIVATE_ORIGINAL');
    await edit(a, '公开问题', '公开答案 [p.1 ¶1]');
    const current = (await turns(p, s))[0]!;
    await done(p, s, 'attention SECRET_UNSELECTED');
    const r = await publish(p, [selection(current)]);
    expect(r.statusCode, r.body).toBe(201);
    const copy = r.json<{ paper: Paper }>().paper;
    const sessions = (await member.req('GET', `${base(copy)}/qa/sessions`)).json<
      PaperQaSession[]
    >();
    expect(sessions).toHaveLength(1);
    const rows = await turns(copy, sessions[0]!, member);
    expect(rows).toHaveLength(1);
    const b = rows[0]!;
    expect(b.id).not.toBe(a.id);
    expect(b.originalAnswer).toBe(current.answer);
    expect(b.originalQuestion).toBe(current.question);
    expect(b.sources[0]).toMatchObject({ paperId: copy.id, fileId: copy.fileId });
    const serialized = JSON.stringify(rows);
    for (const secret of ['PRIVATE_ORIGINAL', 'SECRET_UNSELECTED', p.id, a.id, p.fileId!])
      expect(serialized).not.toContain(secret);
    await edit(b, '团队问题', '团队改写', member);
    expect((await turns(p, s))[0]?.answer).toBe(current.answer);
    const revisions = (await member.req('GET', `${base(copy)}/qa/turns/${b.id}/revisions`)).json();
    expect(JSON.stringify(revisions)).not.toContain('PRIVATE_ORIGINAL');
  });
  it('依赖漏选时预览警告，未经确认拒绝；明确确认后只保留标记', async () => {
    const p = await seed(),
      s = await session(p),
      a = await done(p, s, 'attention PRIVATE_CONTEXT'),
      b = await done(p, s, 'attention followup', { contextTurnIds: [a.id] });
    const pr = await preview(p, [selection(b)]);
    expect(pr.statusCode, pr.body).toBe(200);
    expect(pr.json<PaperQaPublishPreview>().turns[0]?.missingContext[0]?.id).toBe(a.id);
    expect((await publish(p, [selection(b)])).statusCode).toBe(422);
    const r = await publish(p, [selection(b, { allowMissingContext: true })]);
    expect(r.statusCode, r.body).toBe(201);
    const copy = r.json<{ paper: Paper }>().paper,
      ss = (await member.req('GET', `${base(copy)}/qa/sessions`)).json<PaperQaSession[]>();
    const result = await turns(copy, ss[0]!, member);
    expect(result[0]).toMatchObject({ context: [], contextOmitted: true });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CONTEXT');
  });
  it('补选匹配版本的历史问答时映射到新编号，编辑过的版本仍会提示', async () => {
    const p = await seed(),
      s = await session(p),
      a = await done(p, s),
      b = await done(p, s, 'attention followup', { contextTurnIds: [a.id] });
    expect(
      (await preview(p, [selection(a), selection(b)])).json<PaperQaPublishPreview>().turns[1]
        ?.missingContext,
    ).toEqual([]);
    await edit(a, '更改前提', '更改结论');
    const latest = (await turns(p, s))[0]!;
    expect(
      (await preview(p, [selection(latest), selection(b)])).json<PaperQaPublishPreview>().turns[1]
        ?.missingContext,
    ).toHaveLength(1);
  });
  it('未共享私人来源可标记或移除，结构化数据与已知私人链接均清理', async () => {
    const p = await seed(),
      other = await seed(),
      s = await session(p),
      a = await done(p, s);
    const [op] = await t.db.db.select().from(papers).where(eq(papers.id, other.id));
    const source: PaperQaSource = {
      ...a.sources[0]!,
      id: 'private-source',
      paperId: other.id,
      fileId: other.fileId,
      pdfSha256: op!.pdfSha256,
      citekey: 'private2026',
      quote: 'PRIVATE_RETRIEVAL',
    };
    await t.db.db
      .update(paperQaTurns)
      .set({ sources: [...a.sources, source] })
      .where(eq(paperQaTurns.id, a.id));
    await edit(
      a,
      '公开问题',
      `已知 [p.1 ¶1]，外部结论 [private2026, p.1 ¶1]，/api/v1/library/papers/${other.id}/pdf`,
    );
    const now = (await turns(p, s))[0]!;
    const marked = (await preview(p, [selection(now)])).json<PaperQaPublishPreview>().turns[0]!;
    expect(marked.answer).toContain('来源未共享');
    expect(marked.answer).not.toContain(other.id);
    expect(marked.sources.find((x) => x.status === 'unshared')).toMatchObject({
      paperId: null,
      fileId: null,
      quote: '',
      boxes: [],
    });
    const removed = (
      await preview(p, [selection(now, { unsharedSources: 'remove' })])
    ).json<PaperQaPublishPreview>().turns[0]!;
    expect(removed.answer).not.toContain('private2026');
    expect(removed.sources).toHaveLength(1);
    const pub = await publish(p, [selection(now)]);
    expect(pub.statusCode, pub.body).toBe(201);
    const copied = await t.db.db
      .select()
      .from(paperQaTurns)
      .where(eq(paperQaTurns.paperId, pub.json<{ paper: Paper }>().paper.id));
    expect(JSON.stringify(copied)).not.toContain('PRIVATE_RETRIEVAL');
    expect(JSON.stringify(copied)).not.toContain(other.id);
  });
  it('其他来源先发布后可映射到已有团队论文，过期版本不会映射', async () => {
    const other = await seed(),
      p = await seed(),
      s = await session(p),
      a = await done(p, s),
      [op] = await t.db.db.select().from(papers).where(eq(papers.id, other.id));
    const source = {
      ...a.sources[0]!,
      id: 'external',
      paperId: other.id,
      fileId: other.fileId,
      pdfSha256: op!.pdfSha256,
      citekey: 'external2026',
    };
    await t.db.db
      .update(paperQaTurns)
      .set({ sources: [source] })
      .where(eq(paperQaTurns.id, a.id));
    await edit(a, '外部问题', '实验结论 [external2026, p.1 ¶1]');
    const now = (await turns(p, s))[0]!,
      publication = await publish(other, []);
    expect(publication.statusCode, publication.body).toBe(201);
    const target = publication.json<{ paper: Paper }>().paper;
    const pr = (await preview(p, [selection(now)])).json<PaperQaPublishPreview>();
    expect(pr.turns[0]?.sources[0]).toMatchObject({
      paperId: target.id,
      fileId: target.fileId,
      status: 'available',
    });
    await t.db.db.update(papers).set({ pdfSha256: 'changed' }).where(eq(papers.id, target.id));
    expect(
      (await preview(p, [selection(now)])).json<PaperQaPublishPreview>().turns[0]?.sources[0]
        ?.status,
    ).toBe('unshared');
  });
  it('预览后编辑导致整次发布回滚；保存引用版本和默认空选兼容', async () => {
    const p = await seed(),
      s = await session(p),
      a = await done(p, s);
    await preview(p, [selection(a)]);
    await edit(a, '已修改', '新答案');
    const r = await publish(p, [selection(a)]);
    expect(r.statusCode).toBe(409);
    expect(
      await t.db.db
        .select()
        .from(papers)
        .where(
          and(
            eq(papers.projectId, pid),
            eq(
              papers.pdfSha256,
              (await t.db.db.select().from(papers).where(eq(papers.id, p.id)))[0]!.pdfSha256!,
            ),
          ),
        ),
    ).toHaveLength(0);
    expect(
      sanitizeQaPublication('see file:///D:/private.txt and lqt_01ARZ3NDEKTSV4RRFFQ69G5FAV').text,
    ).not.toContain('private.txt');
  });
});
describe('L14 协同维护', () => {
  it('两个真实 WebSocket 同时编辑问题和答案可收敛，原始输出保持不变，记录保存者', async () => {
    const p = await seed(true),
      s = await session(p),
      r = await done(p, s),
      a = connect(r.id, owner),
      b = connect(r.id, member);
    try {
      await wait(() => a.provider.isSynced && b.provider.isSynced);
      a.doc.getText('question').insert(0, '甲');
      b.doc.getText('question').insert(0, '乙');
      a.doc.getText('answer').insert(0, 'A');
      b.doc.getText('answer').insert(0, 'B');
      await wait(
        () =>
          a.doc.getText('answer').toString() === b.doc.getText('answer').toString() &&
          a.doc.getText('question').toString() === b.doc.getText('question').toString(),
      );
      await owner.req('POST', `${base(p)}/qa/turns/${r.id}/flush`);
      const stored = (await turns(p, s))[0]!;
      expect(stored.question).toContain('甲');
      expect(stored.question).toContain('乙');
      expect(stored.answer).toContain('A');
      expect(stored.answer).toContain('B');
      expect(stored.originalAnswer).toBe(r.answer);
      expect(stored.version).toBeGreaterThan(1);
      const revs = await t.db.db
        .select()
        .from(paperQaRevisions)
        .where(eq(paperQaRevisions.turnId, r.id));
      expect(
        revs.some(
          (x) => x.kind === 'edited' && [owner.user.id, member.user.id].includes(x.actor.id!),
        ),
      ).toBe(true);
    } finally {
      a.close();
      b.close();
    }
  });
  it('未获授权者不能建立私人协作连接；访客可以共同维护已完成的团队问答', async () => {
    const p = await seed(),
      s = await session(p),
      r = await done(p, s);
    const socket = new WebSocket(`${url}/${r.id}`, { headers: { cookie: member.cookie } });
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    expect(code).toBe(4404);
    const team = await seed(true),
      ts = await session(team),
      tr = await done(team, ts);
    await edit(tr, '访客补充', '团队核对', guest);
    expect((await turns(team, ts))[0]?.answer).toBe('团队核对');
  });
  it('生成期间不能进入协作编辑，删除论文关闭已打开的问答连接', async () => {
    mode = 'hang';
    const p = await seed(true),
      s = await session(p),
      pending = await ask(p, s);
    const socket = new WebSocket(`${url}/${pending.id}`, { headers: { cookie: owner.cookie } });
    expect(await new Promise<number>((resolve) => socket.on('close', resolve))).toBe(4404);
    await owner.req('POST', `${base(p)}/qa/turns/${pending.id}/stop`);
    mode = 'ok';
    const r = await done(p, s),
      c = connect(r.id, member);
    try {
      await wait(() => c.provider.isSynced);
      expect(documentConnections(t.app.ctx, r.id).length).toBeGreaterThan(0);
      expect((await owner.req('DELETE', base(p))).statusCode).toBe(204);
      await wait(() => documentConnections(t.app.ctx, r.id).length === 0);
      expect((await member.req('GET', `${base(p)}/qa/sessions`)).statusCode).toBe(404);
    } finally {
      c.close();
    }
  });
  it('生成者被移出团队后任务停止并记录未完成，不能继续写出成功回答', async () => {
    const extra = await setupProject(t.app, ['member']),
      who = extra.others[0]!;
    const p = await seed(true),
      s = await session(p);
    await t.db.db
      .insert(projectMembers)
      .values({ projectId: pid, userId: who.user.id, role: 'member' });
    mode = 'hang';
    const r = await ask(p, s, 'attention removed', {}, who);
    await vi.waitFor(async () =>
      expect((await turns(p, s)).find((x) => x.id === r.id)?.answer).toContain('回答'),
    );
    expect((await owner.req('DELETE', `/projects/${pid}/members/${who.user.id}`)).statusCode).toBe(
      204,
    );
    await waitForQaJobs(t.app.ctx);
    expect((await turns(p, s)).find((x) => x.id === r.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('权限'),
    });
  });
});
