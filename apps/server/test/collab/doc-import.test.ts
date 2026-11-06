import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  DOC_IMPORT_MAX_BYTES,
  LATEX_LIMITS,
  type AnyProjectEvent,
  type DocumentContent,
  type DocumentMeta,
} from '@srh/shared';
import { documents, files } from '../../src/db/schema';
import { setupCollabApp, type CollabTestApp } from './helpers';

const PID = 'prj_import';
const OTHER = 'prj_import_other';
const base = `/api/v1/projects/${PID}`;

let t: CollabTestApp;
let events: AnyProjectEvent[] = [];

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser('usr_a', '张三', 1);
  await t.seedUser('usr_g', '访客', 3);
  await t.seedUser('usr_x', '外人', 4);
  await t.seedProject(PID, 'usr_a');
  await t.addMember(PID, 'usr_g', 'guest');
  await t.seedProject(OTHER, 'usr_x');
  const actor = { kind: 'user' as const, id: 'usr_a', name: '张三' };
  await t.db.db.insert(files).values([
    {
      id: 'fil_fig',
      projectId: PID,
      name: 'arch.png',
      path: 'imports/x/figures/arch.png',
      mime: 'image/png',
      size: 1234,
      uploadedBy: actor,
    },
    {
      id: 'fil_secret',
      projectId: OTHER,
      name: 'secret.png',
      path: 'secret.png',
      mime: 'image/png',
      size: 99,
      uploadedBy: actor,
    },
  ]);
  t.app.ctx.bus.onEvent((ev) => events.push(ev));
}, 60_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  events = [];
});

function importUrl(q: Record<string, string>) {
  return `${base}/docs/import?${new URLSearchParams(q).toString()}`;
}

async function postImport(q: Record<string, string>, body: Uint8Array | string, user = 'usr_a') {
  return t.app.inject({
    method: 'POST',
    url: importUrl(q),
    headers: { ...t.as(user), 'content-type': 'application/octet-stream' },
    payload: typeof body === 'string' ? body : Buffer.from(body),
  });
}

function latexState(opts: { assetId?: string; extraFiles?: number } = {}): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc
      .getText('source')
      .insert(
        0,
        '\\documentclass{ctexart}\n\\begin{document}\n\\section{引言}\n中文正文\\cite{li2024}\n\\bibliography{references}\n\\end{document}\n',
      );
    const bib = new Y.Text();
    bib.insert(0, '@article{li2024, title={研究}, year={2024}}\n');
    doc.getMap<Y.Text>('files').set('references.bib', bib);
    for (let i = 0; i < (opts.extraFiles ?? 0); i += 1) {
      const t = new Y.Text();
      t.insert(0, `% ${i}`);
      doc.getMap<Y.Text>('files').set(`sections/s${i}.tex`, t);
    }
    if (opts.assetId) {
      doc
        .getMap('assets')
        .set('figures/arch.png', { fileId: opts.assetId, mime: 'image/png', size: 1234 });
    }
  });
  return Y.encodeStateAsUpdate(doc);
}

async function readMarkdown(id: string): Promise<DocumentContent> {
  const res = await t.app.inject({
    method: 'GET',
    url: `${base}/docs/${id}/markdown`,
    headers: t.as('usr_a'),
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('POST P/docs/import', () => {
  it('LaTeX 工程：带文件与图片原子新建，markdown / 文件清单可读，发 document.created', async () => {
    const res = await postImport(
      { kind: 'latex', title: '中文论文' },
      latexState({ assetId: 'fil_fig' }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const meta = res.json<DocumentMeta>();
    expect(meta).toMatchObject({ kind: 'latex', title: '中文论文', parentId: null });
    expect(meta.excerpt).toContain('引言');
    const content = await readMarkdown(meta.id);
    expect(content.markdown).toContain('中文正文');
    expect(content.files?.map((f) => f.name)).toEqual([
      'main.tex',
      'references.bib',
      'figures/arch.png',
    ]);
    expect(events.map((e) => e.type)).toContain('document.created');
  });

  it('富文本：XmlFragment 状态导入后服务端 markdown 读取正常，可挂到父文档下', async () => {
    const parent = await t.app.inject({
      method: 'POST',
      url: `${base}/docs`,
      headers: t.as('usr_a'),
      payload: { title: '父文档' },
    });
    const parentId = parent.json<DocumentMeta>().id;
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    const h = new Y.XmlElement('heading');
    h.setAttribute('level', '1');
    h.insert(0, [new Y.XmlText('导入的标题')]);
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('第一段中文。')]);
    frag.insert(0, [h, p]);
    const res = await postImport(
      { kind: 'doc', title: '周报', parentId },
      Y.encodeStateAsUpdate(doc),
    );
    expect(res.statusCode, res.body).toBe(201);
    const meta = res.json<DocumentMeta>();
    expect(meta.parentId).toBe(parentId);
    const content = await readMarkdown(meta.id);
    expect(content.markdown).toContain('# 导入的标题');
    expect(content.outline).toEqual([{ heading: '导入的标题', level: 1 }]);
  });

  it('权限：访客 403、非成员 404', async () => {
    const state = latexState();
    expect((await postImport({ kind: 'latex' }, state, 'usr_g')).statusCode).toBe(403);
    expect((await postImport({ kind: 'latex' }, state, 'usr_x')).statusCode).toBe(404);
  });

  it('校验：缺 kind、乱码、空内容、不认识的 content-type、父文档不存在', async () => {
    const before = await t.db.db.select({ id: documents.id }).from(documents);
    expect((await postImport({}, latexState())).statusCode).toBe(422);
    const garbage = await postImport({ kind: 'latex' }, new Uint8Array([1, 2, 3, 250, 251]));
    expect(garbage.statusCode).toBe(422);
    expect((await postImport({ kind: 'doc' }, new Uint8Array())).statusCode).toBeGreaterThanOrEqual(
      400,
    );
    const json = await t.app.inject({
      method: 'POST',
      url: importUrl({ kind: 'doc' }),
      headers: t.as('usr_a'),
      payload: { state: 'x' },
    });
    expect(json.statusCode).toBe(400);
    const orphan = await postImport({ kind: 'latex', parentId: 'doc_missing' }, latexState());
    expect(orphan.statusCode).toBe(404);
    // 失败的导入不留下任何文档
    const after = await t.db.db.select({ id: documents.id }).from(documents);
    expect(after.length).toBe(before.length);
  });

  it('截断的更新（依赖缺失）被拒绝', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'a');
    const sv = Y.encodeStateVector(doc);
    doc.getText('source').insert(1, 'b');
    // 只发第二次修改：缺少第一次的结构
    const tail = Y.encodeStateAsUpdate(doc, sv);
    expect((await postImport({ kind: 'latex' }, tail)).statusCode).toBe(422);
  });

  it('LaTeX：别的项目的图片、非法路径、文件数超限都拒绝', async () => {
    expect(
      (await postImport({ kind: 'latex' }, latexState({ assetId: 'fil_secret' }))).statusCode,
    ).toBe(422);
    expect(
      (await postImport({ kind: 'latex' }, latexState({ assetId: 'fil_nope' }))).statusCode,
    ).toBe(422);
    const bad = new Y.Doc();
    const tx = new Y.Text();
    tx.insert(0, 'x');
    bad.getMap<Y.Text>('files').set('../etc/passwd.tex', tx);
    expect((await postImport({ kind: 'latex' }, Y.encodeStateAsUpdate(bad))).statusCode).toBe(422);
    const many = latexState({ extraFiles: LATEX_LIMITS.files });
    const res = await postImport({ kind: 'latex' }, many);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { message: string } }>().error.message).toContain(
      String(LATEX_LIMITS.files),
    );
  });

  it('幂等键：断线重试不会建出第二份文档；失败的键可以重试；删掉后重新导入', async () => {
    const importId = 'imp_retry_0001';
    const first = await postImport({ kind: 'latex', title: '重试', importId }, latexState());
    expect(first.statusCode).toBe(201);
    const again = await postImport({ kind: 'latex', title: '重试', importId }, latexState());
    expect(again.statusCode).toBe(200);
    expect(again.json<DocumentMeta>().id).toBe(first.json<DocumentMeta>().id);

    const failId = 'imp_fail_0001';
    const bad = await postImport({ kind: 'latex', importId: failId }, new Uint8Array([9, 9, 9]));
    expect(bad.statusCode).toBe(422);
    expect((await postImport({ kind: 'latex', importId: failId }, latexState())).statusCode).toBe(
      201,
    );

    await t.app.inject({
      method: 'DELETE',
      url: `${base}/docs/${first.json<DocumentMeta>().id}`,
      headers: t.as('usr_a'),
    });
    const fresh = await postImport({ kind: 'latex', importId }, latexState());
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json<DocumentMeta>().id).not.toBe(first.json<DocumentMeta>().id);
    expect(
      (await postImport({ kind: 'latex', importId: 'bad id!' }, latexState())).statusCode,
    ).toBe(422);
  });

  it('超过大小上限 → 413', async () => {
    const res = await postImport({ kind: 'doc' }, new Uint8Array(DOC_IMPORT_MAX_BYTES + 10));
    expect(res.statusCode).toBe(413);
  });
});
