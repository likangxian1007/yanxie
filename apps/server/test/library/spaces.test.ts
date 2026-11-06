import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Paper, Project, ShareResolveResult, ShareSettings } from '@srh/shared';
import { libraryTools } from '../../src/agents/tools/library';
import type { ToolContext } from '../../src/agents/tools/types';
import { files, papers } from '../../src/db/schema';
import { importUpload } from '../../src/modules/library/service';
import { makeApp, setupProject, type Session, type TestApp } from '../helpers';
import { tinyPdf } from './util';

/**
 * 个人文献 / 团队文献库（API.md §2.19）：个人文献只有自己能看到，PDF 不进共享文件夹；
 * 链接分享只读 → 能看不能改；可编辑 → 能改；关闭 → 看不到；加入团队库后全组可见；
 * 去重、引用键按库算；agent 检索不出别人的个人文献。
 */
let t: TestApp;
let project: Project;
let a: Session;
let b: Session;
let c: Session;
let P = '';

const pdf = (text: string) => tinyPdf([[{ x: 72, y: 720, text, size: 14 }]]);

async function importAs(s: Session, text: string, personal: boolean) {
  return importUpload(
    t.app.ctx,
    { kind: 'user', id: s.user.id, name: s.user.name },
    project.id,
    { data: pdf(text), filename: `${text}.pdf` },
    personal ? s.user.id : null,
  );
}

const ids = async (s: Session, space?: string) =>
  (await s.req('GET', `${P}/library/papers${space ? `?space=${space}` : ''}`))
    .json<Paper[]>()
    .map((p) => p.id);

beforeAll(async () => {
  t = await makeApp();
  const p = await setupProject(t.app, ['member', 'member']);
  project = p.project;
  a = p.owner;
  [b, c] = p.others as [Session, Session];
  P = `/projects/${project.id}`;
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('个人文献', () => {
  let paper: Paper;

  it('只有自己能看到；PDF 存私有目录、不进项目文件', async () => {
    const out = await importAs(a, 'Mine Only', true);
    expect(out.row.space).toBe('personal');
    expect(out.row.fileId).toBeNull();
    expect(out.row.privatePdfPath).toBeTruthy();
    paper = (await a.req('GET', `${P}/library/papers/${out.row.id}`)).json<Paper>();
    expect(paper.access).toBe('manage');
    expect(await ids(a, 'personal')).toContain(paper.id);
    expect(await ids(a, 'team')).not.toContain(paper.id);
    expect(await ids(b)).not.toContain(paper.id);
    expect((await b.req('GET', `${P}/library/papers/${paper.id}`)).statusCode).toBe(404);
    expect((await b.req('GET', `${P}/library/papers/${paper.id}/pdf`)).statusCode).toBe(404);
    expect((await a.req('GET', `${P}/library/papers/${paper.id}/pdf`)).statusCode).toBe(200);
    const rows = await t.db.db.select().from(files).where(eq(files.projectId, project.id));
    expect(rows).toHaveLength(0);
    // 检索、BibTeX 导出全部都不含别人的个人文献
    const bib = await b.req('POST', `${P}/library/bibtex`, {});
    expect(bib.statusCode).toBe(200);
    expect(bib.body).not.toContain(paper.citekey);
    expect(
      (await b.req('POST', `${P}/library/bibtex`, { paperIds: [paper.id] })).body,
    ).not.toContain(paper.citekey);
  });

  it('同一个 PDF：个人文献和团队库各自去重', async () => {
    const team = await importAs(b, 'Mine Only', false);
    expect(team.duplicate).toBe(false);
    expect(team.row.space).toBe('team');
    const again = await importAs(a, 'Mine Only', true);
    expect(again.duplicate).toBe(true);
    expect(again.row.id).toBe(paper.id);
  });

  it('只读链接：B 能看 PDF、不能改；可编辑后能改；关闭后看不到', async () => {
    const s = (
      await a.req('PATCH', `${P}/shares/paper/${paper.id}/link`, {
        scope: 'project',
        level: 'view',
      })
    ).json<ShareSettings>();
    const opened = await b.req('POST', `/share/${s.link.token}`);
    expect(opened.statusCode).toBe(200);
    expect(opened.json<ShareResolveResult>().resourceKind).toBe('paper');
    const sharedPdf = await b.req('GET', `${P}/library/papers/${paper.id}/pdf`);
    expect(sharedPdf.statusCode).toBe(200);
    // 权限随时可能收回：个人文献的 PDF 不进浏览器缓存
    expect(sharedPdf.headers['cache-control']).toContain('no-store');
    expect(await ids(b, 'shared')).toContain(paper.id);
    expect(
      (await b.req('PATCH', `${P}/library/papers/${paper.id}`, { tags: ['x'] })).statusCode,
    ).toBe(403);
    expect((await b.req('DELETE', `${P}/library/papers/${paper.id}`)).statusCode).toBe(403);
    await a.req('PATCH', `${P}/shares/paper/${paper.id}/link`, { level: 'edit' });
    expect(
      (await b.req('PATCH', `${P}/library/papers/${paper.id}`, { tags: ['gnn'] })).statusCode,
    ).toBe(200);
    // 可编辑也不能删别人的个人文献
    expect((await b.req('DELETE', `${P}/library/papers/${paper.id}`)).statusCode).toBe(403);
    await a.req('PATCH', `${P}/shares/paper/${paper.id}/link`, { scope: 'invited' });
    expect((await b.req('GET', `${P}/library/papers/${paper.id}`)).statusCode).toBe(404);
    expect(await ids(b)).not.toContain(paper.id);
  });

  it('加入团队库：库里已有同一篇时 409；没有时全组可见，PDF 复制进共享文件夹', async () => {
    expect(
      (await a.req('POST', `${P}/library/papers/${paper.id}/move`, { space: 'team' })).statusCode,
    ).toBe(409);
    const own = await importAs(a, 'Only Mine Now', true);
    expect((await c.req('GET', `${P}/library/papers/${own.row.id}`)).statusCode).toBe(404);
    expect(
      (await c.req('POST', `${P}/library/papers/${own.row.id}/move`, { space: 'team' })).statusCode,
    ).toBe(404);
    const moved = await a.req('POST', `${P}/library/papers/${own.row.id}/move`, { space: 'team' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<Paper>().space).toBe('team');
    expect(await ids(c, 'team')).toContain(own.row.id);
    expect((await c.req('GET', `${P}/library/papers/${own.row.id}/pdf`)).statusCode).toBe(200);
    const [row] = await t.db.db.select().from(papers).where(eq(papers.id, own.row.id));
    expect(row!.fileId).toBeTruthy();
    expect(row!.privatePdfPath).toBeNull();
    // 团队文献普通成员不能收进自己的个人文献（只有负责人 / 导师 / 创建者）
    expect(
      (await c.req('POST', `${P}/library/papers/${own.row.id}/move`, { space: 'personal' }))
        .statusCode,
    ).toBe(403);
  });

  it('上传时选个人空间（multipart space 字段）', async () => {
    const boundary = '----srhtest';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="space"\r\n\r\npersonal\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.pdf"\r\n` +
          'Content-Type: application/pdf\r\n\r\n',
      ),
      pdf('C Private'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1${P}/library/papers`,
      headers: { cookie: c.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json<{ paper: Paper }>().paper;
    expect(p.space).toBe('personal');
    expect(p.ownerUserId).toBe(c.user.id);
    expect(await ids(a)).not.toContain(p.id);
  });
});

describe('agent 检索不出别人的个人文献', () => {
  function toolCtx(role: 'coordinator' | 'personal', userId: string | null) {
    return {
      ctx: t.app.ctx,
      session: { id: `ses_${role}`, role, workingForUserId: userId },
      project: { id: project.id },
      thread: null,
      turnId: 'turn_test',
      actor: { kind: 'agent', id: `ses_${role}`, name: 'agent' },
      requesterUserId: userId,
      visible: new Set(),
      setActivity: async () => {},
    } as unknown as ToolContext;
  }
  const run = (tc: ToolContext, name: string, args: unknown) => {
    const def = libraryTools.find((d) => d.name === name)!;
    return def.run(tc, def.schema.parse(args) as never) as Promise<unknown>;
  };

  it('协调者和别人的个人工作区读不到；主人的个人工作区能读', async () => {
    const priv = (await t.db.db.select().from(papers)).find(
      (r) => r.space === 'personal' && r.ownerUserId === a.user.id,
    )!;
    await expect(
      run(toolCtx('coordinator', a.user.id), 'library_read', { paper: priv.id }),
    ).rejects.toThrow();
    await expect(
      run(toolCtx('personal', b.user.id), 'library_read', { paper: priv.id }),
    ).rejects.toThrow();
    await expect(
      run(toolCtx('personal', a.user.id), 'library_read', { paper: priv.id }),
    ).resolves.toBeTruthy();
  });
});
