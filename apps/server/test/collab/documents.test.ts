import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { AddressInfo } from 'node:net';
import type { DocumentContent, DocumentMeta } from '@srh/shared';
import { collab } from '../../src/agents/tools/collab-port';
import { markdownToPm, pmToMarkdown } from '../../src/modules/documents/markdown';
import { parseSlidesMarkdown } from '../../src/modules/documents/ydoc';
import { setupCollabApp, type CollabTestApp } from './helpers';

const PID = 'prj_docs';
const base = `/api/v1/projects/${PID}`;

let t: CollabTestApp;

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser('usr_a', '张三', 1);
  await t.seedUser('usr_b', '李四', 2);
  await t.seedUser('usr_g', '访客', 3);
  await t.seedUser('usr_x', '外人', 4);
  await t.seedProject(PID, 'usr_a');
  await t.allowAgentDirectWrite(PID);
  await t.addMember(PID, 'usr_b', 'member');
  await t.addMember(PID, 'usr_g', 'guest');
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function create(body: Record<string, unknown>, user = 'usr_a'): Promise<DocumentMeta> {
  const res = await t.app.inject({
    method: 'POST',
    url: `${base}/docs`,
    headers: t.as(user),
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function read(id: string): Promise<DocumentContent> {
  const res = await t.app.inject({
    method: 'GET',
    url: `${base}/docs/${id}/markdown`,
    headers: t.as('usr_a'),
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function edit(id: string, payload: Record<string, unknown>, user = 'usr_a') {
  return t.app.inject({
    method: 'POST',
    url: `${base}/docs/${id}/edit`,
    headers: t.as(user),
    payload,
  });
}

describe('markdown 转换', () => {
  it('往返保留结构', () => {
    const src = [
      '# 标题',
      '',
      '一段 **粗体** 与 *斜体*，公式 $E=mc^2$，[链接](https://example.com)。',
      '',
      '- 第一',
      '- 第二',
      '',
      '1. 甲',
      '2. 乙',
      '',
      '- [ ] 待办',
      '- [x] 已完成',
      '',
      '> 引用',
      '',
      '```python',
      'print(1)',
      '```',
      '',
      '$$',
      '\\int_0^1 x\\,dx',
      '$$',
      '',
      '| 模型 | acc |',
      '| --- | --- |',
      '| ResNet | 0.76 |',
    ].join('\n');
    const json = markdownToPm(src);
    const types = (json.content ?? []).map((n) => n.type);
    expect(types).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'codeBlock',
      'blockMath',
      'table',
    ]);
    const back = pmToMarkdown(json);
    expect(back).toContain('**粗体**');
    expect(back).toContain('$E=mc^2$');
    expect(back).toContain('- [x] 已完成');
    expect(back).toContain('| ResNet | 0.76 |');
    expect(back).toContain('```python\nprint(1)\n```');
  });

  it('幻灯片 markdown 分页与版式推断', () => {
    const slides = parseSlidesMarkdown(
      '## 组会汇报\n张三\n\n## 进展\n- 跑完消融\n> 讲慢一点\n\n## 讨论',
    );
    expect(slides.map((s) => s.layout)).toEqual(['title', 'content', 'section']);
    expect(slides[1]!.notes).toBe('讲慢一点');
  });
});

describe('文档 REST', () => {
  it('四类文档都能创建并读成 markdown', async () => {
    const doc = await create({ title: '周报', markdown: '# 本周\n\n完成了 A' });
    expect(doc.kind).toBe('doc');
    expect(doc.excerpt).toContain('完成了 A');
    expect((await read(doc.id)).outline).toEqual([{ heading: '本周', level: 1 }]);

    const sheet = await create({ title: '数据', kind: 'sheet', markdown: 'model,acc\nViT,0.81' });
    expect((await read(sheet.id)).markdown).toContain('| 2 | ViT | 0.81 |');

    const slides = await create({
      title: '汇报',
      kind: 'slides',
      markdown: '## 封面\n\n## 结果\n- 好',
    });
    const sc = await read(slides.id);
    expect(sc.outline.map((o) => o.heading)).toEqual(['封面', '结果']);

    const tex = await create({ title: '论文', kind: 'latex' });
    const tc = await read(tex.id);
    expect(tc.markdown).toContain('\\documentclass{article}');
    expect(tc.outline).toEqual([{ heading: 'Introduction', level: 1 }]);
  });

  it('结构化编辑：小节替换、插入、文本替换', async () => {
    const doc = await create({
      markdown: '# 引言\n\n旧内容\n\n## 背景\n\n背景段\n\n# 方法\n\n方法段',
    });
    let res = await edit(doc.id, { op: 'replace_section', heading: '引言', markdown: '新的引言' });
    expect(res.statusCode).toBe(200);
    let md = res.json().markdown as string;
    expect(md).toContain('新的引言');
    expect(md).not.toContain('背景段');
    expect(md).toContain('方法段');

    res = await edit(doc.id, {
      op: 'insert_after_heading',
      heading: '方法',
      markdown: '- 补充一点',
    });
    md = res.json().markdown;
    expect(md.trim().endsWith('- 补充一点')).toBe(true);

    res = await edit(doc.id, { op: 'replace_text', find: '方法段', replace: '**改过的**方法段' });
    expect(res.json().markdown).toContain('**改过的**方法段');

    res = await edit(doc.id, { op: 'replace_section', heading: '不存在', markdown: 'x' });
    expect(res.statusCode).toBe(404);
    res = await edit(doc.id, { op: 'set_cells', cells: [{ ref: 'A1', value: '1' }] });
    expect(res.statusCode).toBe(400);

    // all=true：替换文本包含查找文本时也要替换全部，且不死循环
    const d2 = await create({ markdown: '甲乙甲乙甲' });
    res = await edit(d2.id, { op: 'replace_text', find: '甲', replace: '甲甲', all: true });
    expect(res.json().markdown).toBe('甲甲乙甲甲乙甲甲');

    // 表格越界：整次编辑被拒绝，已有单元格不受影响
    const sh = await create({ kind: 'sheet', markdown: 'a,b' });
    res = await edit(sh.id, {
      op: 'set_cells',
      cells: [
        { ref: 'A1', value: 'changed' },
        { ref: 'A200000', value: 'x' },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect((await read(sh.id)).markdown).toContain('| 1 | a | b |');
  });

  it('表格写单元格、幻灯片追加、LaTeX 追加到 \\end{document} 之前', async () => {
    const sheet = await create({ kind: 'sheet' });
    let res = await edit(sheet.id, {
      op: 'set_cells',
      cells: [
        { ref: 'A1', value: 'lr' },
        { ref: 'B2', value: '=1+1' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().markdown).toContain('| 2 |  | =1+1 |');

    const slides = await create({ kind: 'slides', title: '分享' });
    await edit(slides.id, {
      op: 'append_slides',
      slides: [{ title: '动机', body: '- 为什么' }],
    });
    expect((await read(slides.id)).outline.map((o) => o.heading)).toEqual(['分享', '动机']);

    const tex = await create({ kind: 'latex' });
    res = await edit(tex.id, { op: 'append', markdown: '\\section{Method}\nWe propose.' });
    const src = res.json().markdown as string;
    expect(src.indexOf('\\section{Method}')).toBeLessThan(src.indexOf('\\end{document}'));
  });

  it('权限：访客只读、非成员 404', async () => {
    const doc = await create({ title: '受保护' });
    const g = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${doc.id}`,
      headers: t.as('usr_g'),
    });
    expect(g.statusCode).toBe(200);
    expect((await edit(doc.id, { op: 'append', markdown: 'x' }, 'usr_g')).statusCode).toBe(403);
    const x = await t.app.inject({ method: 'GET', url: `${base}/docs`, headers: t.as('usr_x') });
    expect(x.statusCode).toBe(404);
  });

  it('更新、归档、搜索、删除', async () => {
    const doc = await create({ title: '注意力机制笔记', markdown: '稀疏注意力可以降低复杂度' });
    const child = await create({ title: '子页', parentId: doc.id });
    let res = await t.app.inject({
      method: 'PATCH',
      url: `${base}/docs/${doc.id}`,
      headers: t.as('usr_b'),
      payload: { parentId: child.id },
    });
    expect(res.statusCode).toBe(422);

    res = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/search?q=稀疏`,
      headers: t.as('usr_a'),
    });
    expect(res.json().map((h: { id: string }) => h.id)).toContain(doc.id);

    res = await t.app.inject({
      method: 'PATCH',
      url: `${base}/docs/${child.id}`,
      headers: t.as('usr_b'),
      payload: { archived: true },
    });
    expect(res.json().archivedAt).not.toBeNull();
    res = await t.app.inject({
      method: 'GET',
      url: `${base}/docs?archived=true`,
      headers: t.as('usr_a'),
    });
    expect(res.json().map((d: DocumentMeta) => d.id)).toEqual([child.id]);

    res = await t.app.inject({
      method: 'DELETE',
      url: `${base}/docs/${doc.id}`,
      headers: t.as('usr_a'),
    });
    expect(res.statusCode).toBe(204);
    res = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${child.id}`,
      headers: t.as('usr_a'),
    });
    expect(res.json().parentId).toBeNull();
  });

  it('版本：保存、查看、恢复', async () => {
    const doc = await create({ markdown: '第一版' });
    let res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${doc.id}/versions`,
      headers: t.as('usr_a'),
      payload: { label: 'v1' },
    });
    expect(res.statusCode).toBe(201);
    const v1 = res.json();
    await edit(doc.id, { op: 'replace_all', markdown: '第二版' });
    res = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${doc.id}/versions/${v1.id}`,
      headers: t.as('usr_a'),
    });
    expect(res.json().markdown).toBe('第一版');
    res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${doc.id}/versions/${v1.id}/restore`,
      headers: t.as('usr_a'),
    });
    expect(res.statusCode).toBe(200);
    expect((await read(doc.id)).markdown).toBe('第一版');
    res = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${doc.id}/versions`,
      headers: t.as('usr_a'),
    });
    expect(res.json()).toHaveLength(2);
  });

  it('AI 未配置时返回 503 llm_unavailable', async () => {
    const doc = await create({ markdown: '内容' });
    const res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${doc.id}/ai`,
      headers: t.as('usr_a'),
      payload: { action: 'continue' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('llm_unavailable');
    const res2 = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${doc.id}/ai`,
      headers: t.as('usr_a'),
      payload: { action: 'polish' },
    });
    expect(res2.statusCode).toBe(422);
  });

  it('agent 端口已注册', async () => {
    const port = collab('documents');
    expect(port).toBeDefined();
    const actor = { kind: 'agent' as const, id: 'agt_1', name: '协调者' };
    const meta = await port!.create(t.app.ctx, actor, PID, { title: 'agent 写的', kind: 'doc' });
    const out = await port!.applyEdit(t.app.ctx, actor, PID, meta.id, {
      op: 'append',
      markdown: '## 结论\n\n有效',
    });
    expect(out.markdown).toContain('## 结论');
    expect(out.meta.updatedBy?.kind).toBe('agent');
    expect(collab('search')).toBeDefined();
  });
});

describe('/collab 实时协同', () => {
  let url = '';
  beforeAll(async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = t.app.server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/collab`;
  }, 30_000);

  function connect(docId: string, user: string) {
    const doc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({
      url: `${url}/${docId}?testUser=${user}`,
      WebSocketPolyfill: WebSocket,
    } as ConstructorParameters<typeof HocuspocusProviderWebsocket>[0]);
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: docId,
      document: doc,
      token: 'cookie',
    });
    provider.attach();
    const synced = new Promise<void>((resolve) => {
      if (provider.isSynced) resolve();
      provider.on('synced', () => resolve());
    });
    return {
      doc,
      provider,
      synced,
      close() {
        provider.destroy();
        socket.destroy();
      },
    };
  }

  const waitFor = async (check: () => boolean, ms = 4000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('超时');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('两个客户端实时同步，agent 编辑实时可见，并落库', async () => {
    const meta = await create({ kind: 'latex', markdown: '\\section{A}\n' });
    const a = connect(meta.id, 'usr_a');
    const b = connect(meta.id, 'usr_b');
    await Promise.all([a.synced, b.synced]);
    expect(a.doc.getText('source').toString()).toContain('\\section{A}');

    a.doc.getText('source').insert(0, '% 张三的注释\n');
    await waitFor(() => b.doc.getText('source').toString().startsWith('% 张三的注释'));

    // agent 通过端口改文档，在线客户端立即看到
    await collab('documents')!.applyEdit(
      t.app.ctx,
      { kind: 'agent', id: 'agt_1', name: '协调者' },
      PID,
      meta.id,
      { op: 'append', markdown: '\\section{B}' },
    );
    await waitFor(() => a.doc.getText('source').toString().includes('\\section{B}'));
    expect(b.doc.getText('source').toString()).toContain('% 张三的注释');

    a.close();
    b.close();
    // 断开后（防抖落库），重新读应包含两人的修改
    await new Promise((r) => setTimeout(r, 2500));
    const content = await read(meta.id);
    expect(content.markdown).toContain('% 张三的注释');
    expect(content.markdown).toContain('\\section{B}');
  }, 15_000);

  it('非成员被拒绝、访客只读', async () => {
    const meta = await create({ kind: 'latex', markdown: 'x' });
    const closeCode = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${url}/${meta.id}?testUser=usr_x`);
      ws.on('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(4404);

    const g = connect(meta.id, 'usr_g');
    await g.synced;
    g.doc.getText('source').insert(0, '访客改的');
    await new Promise((r) => setTimeout(r, 400));
    g.close();
    expect((await read(meta.id)).markdown).not.toContain('访客改的');
  }, 10_000);
});
