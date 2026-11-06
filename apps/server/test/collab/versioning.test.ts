import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as Y from 'yjs';
import {
  notebookCellChanges,
  sheetCellChanges,
  textHunks,
  type ChangeProposal,
  type DocumentMeta,
  type Review,
  type Version,
  type VersionContent,
  type VersionRestoreResult,
} from '@srh/shared';
import { collab } from '../../src/agents/tools/collab-port';
import { writeProjectFile } from '../../src/modules/files/service';
import { createNotebook, readPlainNotebook } from '../../src/modules/notebooks/service';
import { cellsOf, makeCell } from '../../src/modules/notebooks/nbformat';
import { proposeNotebookEditIfNeeded } from '../../src/modules/versioning/proposals';
import { setupCollabApp, type CollabTestApp } from './helpers';

const PID = 'prj_ver';
const base = `/api/v1/projects/${PID}`;
const AGENT = { kind: 'agent' as const, id: 'ses_ver_agent', name: '研协' };

let t: CollabTestApp;

beforeAll(async () => {
  t = await setupCollabApp({ STORAGE_DIR: '.data/test-storage-versioning' });
  await t.seedUser('usr_a', '张导师', 1);
  await t.seedUser('usr_b', '李同学', 2);
  await t.seedProject(PID, 'usr_a');
  await t.addMember(PID, 'usr_b', 'member');
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function req<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
  user = 'usr_a',
): Promise<{ status: number; body: T }> {
  const res = await t.app.inject({
    method,
    url: `${base}${url}`,
    headers: t.as(user),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: res.json() as T };
}

async function createDoc(kind: string, markdown: string, title = '文档'): Promise<DocumentMeta> {
  const r = await req<DocumentMeta>('POST', '/docs', { kind, markdown, title });
  expect(r.status).toBe(201);
  return r.body;
}

async function markdown(docId: string): Promise<string> {
  return (await req<{ markdown: string }>('GET', `/docs/${docId}/markdown`)).body.markdown;
}

async function edit(docId: string, payload: Record<string, unknown>, user = 'usr_b') {
  const r = await req('POST', `/docs/${docId}/edit`, payload, user);
  expect(r.status).toBe(200);
}

async function versionsOf(kind: string, id: string): Promise<Version[]> {
  const r = await req<Version[]>('GET', `/versions?targetKind=${kind}&targetId=${id}`);
  expect(r.status).toBe(200);
  return r.body;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
}

const agentEdit = (docId: string, e: Record<string, unknown>) =>
  collab('documents')!.applyEdit(t.app.ctx, AGENT, PID, docId, e as never);

describe('pure diff helpers', () => {
  it('cuts paragraph hunks with positions', () => {
    const hs = textHunks('a\n\nb\n\nc', 'a\n\nB\n\nc\n\nd', 'block');
    expect(hs).toEqual([
      { before: ['a'], old: ['b'], new: ['B'], after: ['c'], at: 1, atNew: 1 },
      { before: ['c'], old: [], new: ['d'], after: [], at: 3, atNew: 3 },
    ]);
  });

  it('diffs sheets by cell and notebooks by cell id', () => {
    expect(
      sheetCellChanges(
        [{ name: 'S', cells: { A1: '1', B2: 'x' } }],
        [{ name: 'S', cells: { A1: '2', C3: 'y' } }],
      ).map((c) => `${c.ref}:${c.old}->${c.new}`),
    ).toEqual(['A1:1->2', 'B2:x->', 'C3:->y']);
    const ch = notebookCellChanges(
      [
        { id: 'a', type: 'code', source: '1' },
        { id: 'b', type: 'code', source: '2' },
      ],
      [
        { id: 'a', type: 'code', source: '1+1' },
        { id: 'n', type: 'markdown', source: '# t' },
      ],
    );
    expect(ch.map((c) => `${c.status}:${c.cellId}`)).toEqual(['modify:a', 'remove:b', 'add:n']);
    expect(ch[2]!.afterCellId).toBe('a');
  });
});

describe('version history', () => {
  it('auto-snapshots, saves manual versions, diffs and restores as a new version', async () => {
    const doc = await createDoc('doc', '# 引言\n\n第一版内容。');
    // 新建即有一个自动快照
    const first = await waitFor(async () => (await versionsOf('document', doc.id))[0]);
    expect(first.kind).toBe('auto');

    await edit(doc.id, { op: 'replace_text', find: '第一版内容', replace: '第二版内容' });
    const v2 = await req<Version>('POST', '/versions', {
      targetKind: 'document',
      targetId: doc.id,
      note: '改成第二版',
    });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ kind: 'manual', note: '改成第二版' });
    expect(v2.body.createdBy).toMatchObject({ kind: 'user', id: 'usr_a' });

    await edit(doc.id, { op: 'append', markdown: '第三段。' });
    const cur = await req<VersionContent>(
      'GET',
      `/versions/current?targetKind=document&targetId=${doc.id}`,
    );
    expect(cur.body).toMatchObject({ format: 'text', unit: 'block' });
    expect((cur.body as { text: string }).text).toContain('第三段');

    const old = await req<{ content: { text: string } }>('GET', `/versions/${first.id}`);
    expect(old.body.content.text).toContain('第一版内容');

    const r = await req<VersionRestoreResult>('POST', `/versions/${first.id}/restore`, {}, 'usr_b');
    expect(r.status).toBe(200);
    expect(r.body.backup.kind).toBe('pre_restore');
    expect(r.body.restored.kind).toBe('restore');
    expect(await markdown(doc.id)).toContain('第一版内容');
    expect(await markdown(doc.id)).not.toContain('第三段');

    // 历史一条不少：回滚前备份里还有第三段
    const list = await versionsOf('document', doc.id);
    expect(list[0]!.id).toBe(r.body.restored.id);
    const backup = await req<{ content: { text: string } }>('GET', `/versions/${r.body.backup.id}`);
    expect(backup.body.content.text).toContain('第三段');
    expect(list.map((v) => v.kind)).toEqual(
      expect.arrayContaining(['auto', 'manual', 'pre_restore', 'restore']),
    );
  });

  it('versions sheets by cell and notebooks by cell', async () => {
    const sheet = await createDoc('sheet', '| a | b |\n| --- | --- |\n| 1 | 2 |', '数据');
    await req('POST', '/versions', { targetKind: 'document', targetId: sheet.id, note: 'v1' });
    const cur = await req<VersionContent>(
      'GET',
      `/versions/current?targetKind=document&targetId=${sheet.id}`,
    );
    expect(cur.body.format).toBe('sheet');
    expect(
      (cur.body as { sheets: { cells: Record<string, string> }[] }).sheets[0]!.cells,
    ).toMatchObject({ A1: 'a', B2: '2' });

    const nb = await createNotebook(t.app.ctx, { kind: 'user', id: 'usr_a', name: '张导师' }, PID, {
      title: 'nb',
    });
    const v = await req<Version>('POST', '/versions', { targetKind: 'notebook', targetId: nb.id });
    expect(v.status).toBe(201);
    const d = await req<{ content: VersionContent }>('GET', `/versions/${v.body.id}`);
    expect(d.body.content.format).toBe('notebook');
  });

  it('keeps file versions and restores bytes', async () => {
    const actor = { kind: 'user' as const, id: 'usr_a', name: '张导师' };
    const { file } = await writeProjectFile(t.app.ctx, actor, PID, 'notes/run.txt', 'lr=0.1\n');
    await writeProjectFile(t.app.ctx, actor, PID, 'notes/run.txt', 'lr=0.01\n');
    const list = await waitFor(async () => {
      const l = await versionsOf('file', file.id);
      return l.length >= 2 ? l : null;
    });
    const oldest = list[list.length - 1]!;
    const r = await req<VersionRestoreResult>('POST', `/versions/${oldest.id}/restore`);
    expect(r.status).toBe(200);
    const cur = await req<{ text: string }>(
      'GET',
      `/versions/current?targetKind=file&targetId=${file.id}`,
    );
    expect(cur.body.text).toBe('lr=0.1\n');
  });
});

describe('change proposals', () => {
  it('turns agent edits into a proposal, merges accepted hunks around concurrent edits', async () => {
    const doc = await createDoc(
      'doc',
      '# 方法\n\n段落甲。\n\n段落乙。\n\n段落丙。\n\n结尾。',
      '论文',
    );
    const res = await agentEdit(doc.id, {
      op: 'replace_text',
      find: '段落甲',
      replace: '段落甲（改）',
    });
    expect(res.notice).toContain('改动提案');
    await agentEdit(doc.id, { op: 'replace_text', find: '段落丙', replace: '段落丙（改）' });
    await agentEdit(doc.id, { op: 'append', markdown: '新增结论。' });
    // 正文没变
    expect(await markdown(doc.id)).not.toContain('（改）');

    const list = await req<ChangeProposal[]>(
      'GET',
      `/proposals?targetKind=document&targetId=${doc.id}`,
    );
    expect(list.body).toHaveLength(1);
    const p = (await req<ChangeProposal>('GET', `/proposals/${list.body[0]!.id}`)).body;
    expect(p.hunks).toHaveLength(3);
    expect(p.reviewId).toBeTruthy();
    const review = (await req<Review>('GET', `/reviews/${p.reviewId}`)).body;
    expect(review.targetKind).toBe('proposal');
    expect(review.reviewers.map((r) => r.userId)).toEqual(['usr_a']);

    // 合入前有人改了段落乙（提案没碰这里）
    await edit(doc.id, { op: 'replace_text', find: '段落乙', replace: '段落乙（同学改）' });

    const [h1, h2, h3] = p.hunks;
    const dec = await req<ChangeProposal>('PATCH', `/proposals/${p.id}/decisions`, {
      decisions: { [h1!.id]: 'accepted', [h2!.id]: 'rejected', [h3!.id]: 'accepted' },
    });
    expect(dec.status).toBe(200);
    const merged = await req<ChangeProposal>('POST', `/proposals/${p.id}/merge`, {});
    expect(merged.status).toBe(200);
    expect(merged.body.status).toBe('merged');
    expect(merged.body.mergeResult).toMatchObject({
      applied: [h1!.id, h3!.id],
      rejected: [h2!.id],
    });

    const md = await markdown(doc.id);
    expect(md).toContain('段落甲（改）');
    expect(md).toContain('段落乙（同学改）');
    expect(md).toContain('段落丙。');
    expect(md).not.toContain('段落丙（改）');
    expect(md.trim().endsWith('新增结论。')).toBe(true);

    const kinds = (await versionsOf('document', doc.id)).map((v) => v.kind);
    expect(kinds[0]).toBe('merge');
    expect(kinds).toContain('pre_merge');
    const closed = (await req<Review>('GET', `/reviews/${p.reviewId}`)).body;
    expect(closed.status).toBe('closed');
  });

  it('reports conflicts and can skip them', async () => {
    const doc = await createDoc('doc', '甲。\n\n中。\n\n乙。', '冲突');
    await agentEdit(doc.id, { op: 'replace_text', find: '甲', replace: '甲甲' });
    await agentEdit(doc.id, { op: 'replace_text', find: '乙', replace: '乙乙' });
    await edit(doc.id, { op: 'replace_text', find: '甲', replace: '甲（人）' });
    const [p] = (await req<ChangeProposal[]>('GET', `/proposals?targetId=${doc.id}`)).body;
    const detail = (await req<ChangeProposal>('GET', `/proposals/${p!.id}`)).body;
    expect(detail.conflicts).toHaveLength(1);
    const no = await req('POST', `/proposals/${p!.id}/merge`, { acceptPending: true });
    expect(no.status).toBe(409);
    const ok = await req<ChangeProposal>('POST', `/proposals/${p!.id}/merge`, {
      acceptPending: true,
      skipConflicts: true,
    });
    expect(ok.body.mergeResult!.conflicted).toEqual(detail.conflicts);
    const md = await markdown(doc.id);
    expect(md).toContain('甲（人）');
    expect(md).toContain('乙乙');
  });

  it('merges everything when every reviewer gives LGTM', async () => {
    const doc = await createDoc('latex', 'line1\nline2\nline3\n', 'tex');
    await agentEdit(doc.id, { op: 'replace_text', find: 'line2', replace: 'LINE2' });
    const [p] = (await req<ChangeProposal[]>('GET', `/proposals?targetId=${doc.id}`)).body;
    expect(p!.unit).toBe('line');
    const v = await req(`POST`, `/reviews/${p!.reviewId}/verdict`, { verdict: 'lgtm' });
    expect(v.status).toBe(200);
    await waitFor(async () => {
      const cur = (await req<ChangeProposal>('GET', `/proposals/${p!.id}`)).body;
      return cur.status === 'merged';
    });
    expect(await markdown(doc.id)).toBe('line1\nLINE2\nline3\n');
  });

  it('proposes sheet edits cell by cell', async () => {
    const doc = await createDoc('sheet', '| x | y |\n| --- | --- |\n| 1 | 2 |', '表');
    await agentEdit(doc.id, {
      op: 'set_cells',
      cells: [
        { ref: 'A2', value: '10' },
        { ref: 'B2', value: '20' },
      ],
    });
    const [p] = (await req<ChangeProposal[]>('GET', `/proposals?targetId=${doc.id}`)).body;
    expect(p!.hunks.map((h) => (h.kind === 'cell' ? h.ref : ''))).toEqual(['A2', 'B2']);
    await req('PATCH', `/proposals/${p!.id}/decisions`, {
      decisions: { [p!.hunks[0]!.id]: 'accepted', [p!.hunks[1]!.id]: 'rejected' },
    });
    await req('POST', `/proposals/${p!.id}/merge`, {});
    const cur = (
      await req<{ sheets: { cells: Record<string, string> }[] }>(
        'GET',
        `/versions/current?targetKind=document&targetId=${doc.id}`,
      )
    ).body;
    expect(cur.sheets[0]!.cells).toMatchObject({ A2: '10', B2: '2' });
  });

  it('proposes notebook edits by cell', async () => {
    const owner = { kind: 'user' as const, id: 'usr_a', name: '张导师' };
    const nb = await createNotebook(t.app.ctx, owner, PID, { title: '实验' });
    const { nb: plain } = await readPlainNotebook(t.app.ctx, PID, nb.id);
    const first = plain.cells[0]!.id;
    const p = await proposeNotebookEditIfNeeded(t.app.ctx, AGENT, PID, nb.id, (doc) => {
      const cells = cellsOf(doc);
      const src = cells.get(0).get('source') as Y.Text;
      src.insert(0, 'x = 1');
      cells.push([makeCell({ type: 'markdown', source: '# 结果' })]);
      cells.push([makeCell({ type: 'code', source: 'print(x)' })]);
    });
    expect(p).not.toBeNull();
    const detail = (await req<ChangeProposal>('GET', `/proposals/${p!.proposalId}`)).body;
    expect(detail.hunks.map((h) => (h.kind === 'nb_cell' ? h.op : ''))).toEqual([
      'modify',
      'add',
      'add',
    ]);
    // 正文还是空的
    expect((await readPlainNotebook(t.app.ctx, PID, nb.id)).nb.cells).toHaveLength(1);
    await req('PATCH', `/proposals/${detail.id}/decisions`, {
      decisions: { [detail.hunks[1]!.id]: 'rejected' },
    });
    const m = await req<ChangeProposal>('POST', `/proposals/${detail.id}/merge`, {
      acceptPending: true,
    });
    expect(m.status).toBe(200);
    const after = (await readPlainNotebook(t.app.ctx, PID, nb.id)).nb.cells;
    expect(after.map((c) => c.source)).toEqual(['x = 1', 'print(x)']);
    expect(after[0]!.id).toBe(first);
  });

  it('lets managers switch agents to direct writes', async () => {
    const denied = await req('PATCH', '/versioning/settings', { agentDirectWrite: true }, 'usr_b');
    expect(denied.status).toBe(403);
    const ok = await req<{ agentDirectWrite: boolean }>('PATCH', '/versioning/settings', {
      agentDirectWrite: true,
    });
    expect(ok.body.agentDirectWrite).toBe(true);
    const doc = await createDoc('doc', '原文。', '草稿');
    const res = await agentEdit(doc.id, { op: 'append', markdown: '直接写。' });
    expect(res.notice).toBeUndefined();
    expect(await markdown(doc.id)).toContain('直接写。');
    await req('PATCH', '/versioning/settings', { agentDirectWrite: false });
  });
});
