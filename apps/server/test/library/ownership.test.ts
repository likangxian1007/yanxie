import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnyProjectEvent, LibraryHit, Paper, PaperDetail } from '@srh/shared';
import type { LlmClient } from '../../src/agents/llm/client';
import { events, files, papers, projects } from '../../src/db/schema';
import { setLibraryLlmForTest } from '../../src/modules/library/llm';
import { ParserUnavailable } from '../../src/modules/library/parser';
import { setLibraryDepsForTest } from '../../src/modules/library/pipeline';
import { resumePending, waitForQueueIdle } from '../../src/modules/library/queue';
import { findPaper, importByRef } from '../../src/modules/library/service';
import { makeApp, setupProject, signup, type Session, type TestApp } from '../helpers';
import { tinyPdf } from './util';

let t: TestApp;
let alice: Session;
let bob: Session;
let owner: Session;
let guest: Session;
let projectId: string;
let privatePaper: Paper;
let bobPaper: Paper;
let teamPaper: Paper;
const published: AnyProjectEvent[] = [];
let off: () => void;
const modelInputs: string[] = [];

async function upload(session: Session, text: string, base = '/library') {
  const boundary = '----ownership-test';
  const pdf = tinyPdf([[{ x: 72, y: 720, text, size: 12 }]]);
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="paper.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    pdf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/v1${base}/papers`,
    payload,
    headers: {
      cookie: session.cookie,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  await waitForQueueIdle(t.app.ctx);
  return res.json<{ paper: Paper }>().paper;
}

beforeAll(async () => {
  t = await makeApp();
  const p = await setupProject(t.app, ['member', 'guest']);
  owner = p.owner;
  [bob, guest] = p.others as [Session, Session];
  projectId = p.project.id;
  alice = await signup(t.app, '没有加入项目的小王');
  setLibraryDepsForTest(t.app.ctx, {
    parser: () => ({
      name: 'grobid',
      url: 'http://parser.test',
      probe: async () => ({ reachable: false, version: null }),
      parse: async () => {
        throw new ParserUnavailable('测试采用本地文字提取');
      },
    }),
    arxivMeta: async (id) => ({
      title: `Paper ${id}`,
      authors: [],
      year: null,
      venue: null,
      abstract: null,
      doi: null,
      arxivId: id,
      url: null,
      pdfUrl: null,
      bib: {},
    }),
    resolveDoi: async () => null,
    fetchPdf: async () => tinyPdf([[{ x: 72, y: 720, text: 'quartz recovered', size: 12 }]]),
    fetchArxivSource: async () => null,
  });
  const fake: LlmClient = {
    model: 'test',
    reasoningModel: 'test',
    client: {
      chat: {
        completions: {
          create: async (body: { messages: { content: string }[] }) => {
            modelInputs.push(body.messages.map((m) => m.content).join('\n'));
            return (async function* () {
              yield { choices: [{ delta: { content: '有依据的回答。' } }] };
            })();
          },
        },
      },
    } as unknown as LlmClient['client'],
  };
  setLibraryLlmForTest(t.app.ctx, fake);
  off = t.app.ctx.bus.onEvent((event) => published.push(event));
  privatePaper = await upload(alice, 'quartz ALICE_PRIVATE_ONLY');
  bobPaper = await upload(bob, 'quartz BOB_PRIVATE_ONLY');
  teamPaper = await upload(owner, 'quartz TEAM_SHARED_ONLY', `/projects/${projectId}/library`);
}, 60_000);

afterAll(async () => {
  off?.();
  await t?.close();
});

describe('L01：个人归属、文件与模型检索隔离', () => {
  it('未加入项目的用户可以导入、解析和下载私人论文；未登录不能读取', async () => {
    const detail = await alice.req('GET', `/library/papers/${privatePaper.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<PaperDetail>()).toMatchObject({
      projectId: null,
      ownerUserId: alice.user.id,
      status: 'ready',
    });
    const pdf = await alice.req('GET', `/library/papers/${privatePaper.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.body.startsWith('%PDF')).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/library/papers' })).statusCode).toBe(
      401,
    );
    const [file] = await t.db.db.select().from(files).where(eq(files.id, privatePaper.fileId!));
    expect(file).toMatchObject({ projectId: null, ownerUserId: alice.user.id });
  });

  it('同事和项目负责人拿到私人 ID 也不能读、改、下载、导出或问答', async () => {
    for (const who of [bob, owner, guest]) {
      for (const suffix of ['', '/pdf', '/bibtex']) {
        expect(
          (await who.req('GET', `/library/papers/${privatePaper.id}${suffix}`)).statusCode,
        ).toBe(404);
        expect(
          (
            await who.req(
              'GET',
              `/projects/${projectId}/library/papers/${privatePaper.id}${suffix}`,
            )
          ).statusCode,
        ).toBe(404);
      }
      expect(
        (await who.req('PATCH', `/library/papers/${privatePaper.id}`, { note: '越权覆盖' }))
          .statusCode,
      ).toBe(404);
      expect((await who.req('DELETE', `/library/papers/${privatePaper.id}`)).statusCode).toBe(404);
      expect((await who.req('POST', `/library/papers/${privatePaper.id}/reparse`)).statusCode).toBe(
        404,
      );
      expect(
        (await who.req('POST', '/library/qa', { question: 'quartz', paperId: privatePaper.id }))
          .statusCode,
      ).toBe(404);
      expect(
        (await who.req('POST', '/library/bibtex', { paperIds: [privatePaper.id] })).statusCode,
      ).toBe(404);
      expect(
        (await who.req('GET', `/projects/${projectId}/files/${privatePaper.fileId}`)).statusCode,
      ).toBe(404);
    }
    expect(await findPaper(t.app.ctx, projectId, privatePaper.id)).toBeNull();
    expect(
      (await alice.req('POST', '/library/cite', { docId: 'anything', paperIds: [privatePaper.id] }))
        .statusCode,
    ).toBe(404);
  });

  it('列表、重复导入和搜索缓存都按库隔离，无法通过 ID 或同 DOI 串库', async () => {
    const checks = [
      { who: alice, base: '/library', id: privatePaper.id },
      { who: bob, base: '/library', id: bobPaper.id },
      { who: owner, base: `/projects/${projectId}/library`, id: teamPaper.id },
    ];
    for (let pass = 0; pass < 2; pass += 1) {
      for (const { who, base, id } of checks) {
        expect((await who.req('GET', `${base}/papers`)).json<Paper[]>().map((p) => p.id)).toEqual([
          id,
        ]);
        const hits = (await who.req('GET', `${base}/search?q=quartz`)).json<LibraryHit[]>();
        expect(hits.length).toBeGreaterThan(0);
        expect([...new Set(hits.map((h) => h.paperId))]).toEqual([id]);
      }
    }
    expect(
      (await bob.req('GET', `/library/search?q=quartz&paperId=${privatePaper.id}`)).json(),
    ).toEqual([]);
    const a = await alice.req('POST', '/library/papers', {
      arxiv: '2101.00001',
      ownerUserId: bob.user.id,
      projectId,
    });
    const b = await bob.req('POST', '/library/papers', { arxiv: '2101.00001' });
    const again = await alice.req('POST', '/library/papers', { arxiv: '2101.00001' });
    expect(a.json().paper.ownerUserId).toBe(alice.user.id);
    expect(a.json().paper.projectId).toBeNull();
    expect(a.json().paper.id).not.toBe(b.json().paper.id);
    expect(again.json()).toMatchObject({ duplicate: true, paper: { id: a.json().paper.id } });
    await waitForQueueIdle(t.app.ctx);
  });

  it('个人及项目问答送入模型的段落严格分开', async () => {
    for (const { who, base, expected, excluded } of [
      {
        who: alice,
        base: '/library',
        expected: 'ALICE_PRIVATE_ONLY',
        excluded: ['BOB_PRIVATE_ONLY', 'TEAM_SHARED_ONLY'],
      },
      {
        who: owner,
        base: `/projects/${projectId}/library`,
        expected: 'TEAM_SHARED_ONLY',
        excluded: ['ALICE_PRIVATE_ONLY', 'BOB_PRIVATE_ONLY'],
      },
    ]) {
      modelInputs.length = 0;
      const res = await who.req('POST', `${base}/qa`, { question: 'quartz' });
      expect(res.statusCode, res.body).toBe(200);
      expect(modelInputs).toHaveLength(1);
      expect(modelInputs[0]).toContain(expected);
      for (const marker of excluded) expect(modelInputs[0]).not.toContain(marker);
    }
  });

  it('私人论文创建、解析和更新不进入项目广播与历史事件', async () => {
    await alice.req('PATCH', `/library/papers/${privatePaper.id}`, { note: 'PRIVATE_NOTE_MARKER' });
    const history = await t.db.db.select().from(events);
    for (const serialized of [JSON.stringify(published), JSON.stringify(history)]) {
      expect(serialized).not.toContain(privatePaper.id);
      expect(serialized).not.toContain(privatePaper.fileId!);
      expect(serialized).not.toContain('PRIVATE_NOTE_MARKER');
      expect(serialized).toContain(teamPaper.id);
    }
  });

  it('恢复待解析任务保留个人归属，状态接口只统计自己的库', async () => {
    const scope = { kind: 'personal' as const, ownerUserId: alice.user.id };
    const pending = await importByRef(
      t.app.ctx,
      { kind: 'user', id: alice.user.id, name: alice.user.name },
      scope,
      { arxiv: '2102.00002' },
    );
    await resumePending(t.app.ctx);
    const status = await owner.req('GET', `/projects/${projectId}/library/status`);
    expect(status.json().queue).toEqual({ running: 0, waiting: 0 });
    await waitForQueueIdle(t.app.ctx);
    const got = await alice.req('GET', `/library/papers/${pending.row.id}`);
    expect(got.json()).toMatchObject({
      ownerUserId: alice.user.id,
      projectId: null,
      status: 'ready',
    });
    expect((await bob.req('GET', `/library/papers/${pending.row.id}`)).statusCode).toBe(404);
  });

  it('团队论文不能带私人所有者，论文不能无归属；文件仍要求项目与个人二选一', async () => {
    for (const values of [
      { projectId, ownerUserId: alice.user.id },
      { projectId: null, ownerUserId: null },
    ]) {
      await expect(
        t.db.db
          .update(papers)
          .set({ ...values, space: 'team' })
          .where(eq(papers.id, privatePaper.id)),
      ).rejects.toThrow();
      await expect(
        t.db.db.update(files).set(values).where(eq(files.id, privatePaper.fileId!)),
      ).rejects.toThrow();
    }
  });

  it('项目全员可编辑文献信息，访客在其他模块的权限不变', async () => {
    expect(
      (
        await guest.req('PATCH', `/projects/${projectId}/library/papers/${teamPaper.id}`, {
          title: '团队共同维护',
          note: '访客也可补充笔记',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await guest.req('DELETE', `/projects/${projectId}/library/papers/${teamPaper.id}`))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await guest.req('PATCH', `/projects/${projectId}/library/papers/${teamPaper.id}`, {
          archived: true,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await guest.req('POST', `/projects/${projectId}/threads`, { title: '不能越权' })).statusCode,
    ).toBe(403);
  });

  it('退出项目立即失去项目资料访问权，自己的个人库不受影响', async () => {
    expect(
      (await owner.req('DELETE', `/projects/${projectId}/members/${bob.user.id}`)).statusCode,
    ).toBe(204);
    expect(
      (await bob.req('GET', `/projects/${projectId}/library/papers/${teamPaper.id}`)).statusCode,
    ).toBe(404);
    expect((await bob.req('GET', `/library/papers/${bobPaper.id}/pdf`)).statusCode).toBe(200);
  });

  it('删除项目不会级联删除私人论文、段落和 PDF；删除私人论文清理自己的文件', async () => {
    await t.db.db.delete(projects).where(eq(projects.id, projectId));
    const detail = await alice.req('GET', `/library/papers/${privatePaper.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<PaperDetail>().structure!.chunks.length).toBeGreaterThan(0);
    expect((await alice.req('GET', `/library/papers/${privatePaper.id}/pdf`)).statusCode).toBe(200);
    expect((await alice.req('DELETE', `/library/papers/${privatePaper.id}`)).statusCode).toBe(204);
    expect((await alice.req('GET', `/library/papers/${privatePaper.id}/pdf`)).statusCode).toBe(404);
    expect(await t.db.db.select().from(files).where(eq(files.id, privatePaper.fileId!))).toEqual(
      [],
    );
    expect((await bob.req('GET', `/library/papers/${bobPaper.id}/pdf`)).statusCode).toBe(200);
  });
});
