import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorRef, ResearchFinding, ResearchSource } from '@srh/shared';
import { papers } from '../src/db/schema';
import {
  createDocument,
  moveDocumentSpace,
  updateDocument,
} from '../src/modules/documents/service';
import { deleteProjectFile, writeProjectFile } from '../src/modules/files/service';
import { movePaperSpace, updatePaper } from '../src/modules/library/service';
import { createNotebook, updateNotebook } from '../src/modules/notebooks/service';
import { startResearchSourceHooks } from '../src/modules/research/hooks';
import {
  createExcerpt,
  createFinding,
  createRecord,
  createSnapshot,
  createSource,
  getEntity,
  markSourcesForResource,
  readSnapshotBytes,
  sourceAvailability,
  updateFinding,
  updateRecord,
  updateSource,
} from '../src/modules/research/service';
import { setupCollabApp, type CollabTestApp } from './collab/helpers';

const PROJECT = 'prj_research_hooks';
const MEMBER: ActorRef = { kind: 'user', id: 'usr_research_hooks', name: '研究成员' };
let t: CollabTestApp;
let storage: string;
let stopHooks: (() => void) | undefined;

async function source(id: string): Promise<ResearchSource> {
  return getEntity<ResearchSource>(t.app.ctx, PROJECT, 'source', id);
}

async function waitForReview(id: string): Promise<ResearchSource> {
  await vi.waitFor(async () => expect((await source(id)).needsReview).toBe(true), {
    interval: 25,
    timeout: 5_000,
  });
  return source(id);
}

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'srh-research-hooks-'));
  t = await setupCollabApp({ STORAGE_DIR: storage });
  await t.seedUser(MEMBER.id!, MEMBER.name);
  await t.seedProject(PROJECT, MEMBER.id!);
  stopHooks = startResearchSourceHooks(t.app.ctx);
}, 60_000);

afterAll(async () => {
  stopHooks?.();
  await t?.close();
  if (storage) await rm(storage, { recursive: true, force: true });
});

describe('科研来源的上游变更联动', () => {
  it('团队文档与论文移入个人空间后仅保留旧证据并标记待复核', async () => {
    const ctx = t.app.ctx;
    const author = { kind: 'user' as const, id: MEMBER.id!, name: MEMBER.name };
    const doc = await createDocument(ctx, MEMBER, PROJECT, {
      title: '团队文档',
      markdown: '公开版本',
    });
    const paperId = 'ppr_research_move_personal';
    await t.db.db.insert(papers).values({
      id: paperId,
      projectId: PROJECT,
      title: '团队论文',
      citekey: 'researchmovepersonal',
      source: 'upload',
      createdBy: MEMBER,
    });
    const docSource = await createSource(ctx, MEMBER, PROJECT, {
      kind: 'document',
      resourceId: doc.id,
      title: '公开文档来源',
    });
    const paperSource = await createSource(ctx, MEMBER, PROJECT, {
      kind: 'paper',
      resourceId: paperId,
      title: '公开论文来源',
    });
    const old = await createSnapshot(ctx, MEMBER, PROJECT, docSource.id, { coverage: 'complete' });
    const oldBytes = (await readSnapshotBytes(ctx, PROJECT, old.id)).bytes;
    await moveDocumentSpace(ctx, author, 'member', PROJECT, doc.id, 'personal');
    await movePaperSpace(ctx, author, 'member', PROJECT, paperId, 'personal');
    expect((await waitForReview(docSource.id)).title).toBe('公开文档来源');
    expect((await waitForReview(paperSource.id)).title).toBe('公开论文来源');
    expect(await sourceAvailability(ctx, PROJECT, docSource.id)).toMatchObject({
      available: false,
      reason: 'missing',
    });
    expect(await sourceAvailability(ctx, PROJECT, paperSource.id)).toMatchObject({
      available: false,
      reason: 'missing',
    });
    expect((await readSnapshotBytes(ctx, PROJECT, old.id)).bytes).toEqual(oldBytes);
    await expect(
      createSnapshot(ctx, MEMBER, PROJECT, docSource.id, { coverage: 'complete' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      createSnapshot(ctx, MEMBER, PROJECT, paperSource.id, {
        coverage: 'excerpt',
        text: '私人内容',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('实际覆盖文件后标记对应来源与结论待复核，保留旧快照和摘录', async () => {
    const ctx = t.app.ctx;
    const { file } = await writeProjectFile(ctx, MEMBER, PROJECT, 'evidence.txt', '旧版原文');
    const record = await createRecord(ctx, MEMBER, PROJECT, {
      templateId: 'rtpl_preset_general',
      title: '来源变更追踪',
    });
    const linked = await createSource(ctx, MEMBER, PROJECT, {
      recordId: record.id,
      kind: 'file',
      resourceId: file.id,
      title: '原始材料',
    });
    await updateRecord(ctx, MEMBER, PROJECT, record.id, {
      baseVersion: record.version,
      sourceIds: [linked.id],
    });
    const snapshot = await createSnapshot(ctx, MEMBER, PROJECT, linked.id, {
      coverage: 'complete',
    });
    const excerpt = await createExcerpt(ctx, MEMBER, PROJECT, record.id, {
      sourceId: linked.id,
      snapshotId: snapshot.id,
      quote: '旧版原文',
      locator: { kind: 'text', paragraph: 1 },
      origin: 'observation',
    });
    const finding = await createFinding(ctx, MEMBER, PROJECT, record.id, {
      statement: '材料支持原结论',
      supportingExcerptIds: [excerpt.id],
      humanConfirmed: true,
    });

    const { file: unrelatedFile } = await writeProjectFile(
      ctx,
      MEMBER,
      PROJECT,
      'unrelated.txt',
      '无关资料',
    );
    await writeProjectFile(ctx, MEMBER, PROJECT, unrelatedFile.path, '无关资料新版');
    expect((await source(linked.id)).needsReview).toBe(false);
    expect(
      (await getEntity<ResearchFinding>(ctx, PROJECT, 'finding', finding.id)).humanConfirmed,
    ).toBe(true);

    await writeProjectFile(ctx, MEMBER, PROJECT, file.path, '新版原文');
    const marked = await waitForReview(linked.id);
    await vi.waitFor(async () => {
      const changed = await getEntity<ResearchFinding>(ctx, PROJECT, 'finding', finding.id);
      expect(changed.needsReview).toBe(true);
      expect(changed.humanConfirmed).toBe(false);
    });
    expect(marked.updatedBy.kind).toBe('system');
    expect((await readSnapshotBytes(ctx, PROJECT, snapshot.id)).bytes.toString('utf8')).toBe(
      '旧版原文',
    );
    expect(await getEntity(ctx, PROJECT, 'excerpt', excerpt.id)).toMatchObject({
      quote: '旧版原文',
      snapshotId: snapshot.id,
      verification: 'verified',
    });
  });

  it('真实文档、Notebook、论文更新与文件删除只影响绑定的来源', async () => {
    const ctx = t.app.ctx;
    const doc = await createDocument(ctx, MEMBER, PROJECT, { title: '文档', markdown: '初稿' });
    const notebook = await createNotebook(ctx, MEMBER, PROJECT, { title: '分析' });
    const paperId = 'ppr_research_hooks';
    await t.db.db.insert(papers).values({
      id: paperId,
      projectId: PROJECT,
      title: '论文',
      citekey: 'researchhooks2026',
      source: 'upload',
      createdBy: MEMBER,
    });
    const { file } = await writeProjectFile(ctx, MEMBER, PROJECT, 'delete-me.txt', '待删除');
    const resources = [
      { kind: 'document', id: doc.id },
      { kind: 'notebook', id: notebook.id },
      { kind: 'paper', id: paperId },
      { kind: 'file', id: file.id },
    ] as const;
    const sources = [];
    for (const resource of resources)
      sources.push(
        await createSource(ctx, MEMBER, PROJECT, {
          kind: resource.kind,
          resourceId: resource.id,
          title: `${resource.kind} 来源`,
        }),
      );

    await updateDocument(ctx, MEMBER, PROJECT, doc.id, { title: '文档新版' });
    expect((await waitForReview(sources[0]!.id)).updatedBy.kind).toBe('system');
    expect((await source(sources[1]!.id)).needsReview).toBe(false);

    await updateNotebook(ctx, MEMBER, PROJECT, notebook.id, { title: '分析新版' });
    await waitForReview(sources[1]!.id);
    expect((await source(sources[2]!.id)).needsReview).toBe(false);

    await updatePaper(ctx, MEMBER, PROJECT, paperId, { title: '论文新版' });
    await waitForReview(sources[2]!.id);
    expect((await source(sources[3]!.id)).needsReview).toBe(false);

    await deleteProjectFile(ctx, MEMBER, PROJECT, file.id);
    await waitForReview(sources[3]!.id);
    expect(await sourceAvailability(ctx, PROJECT, sources[3]!.id)).toMatchObject({
      available: false,
      reason: 'missing',
    });
  });

  it('来源待复核遇人工并发编辑时重读重试，保留编辑并记录每次上游变化', async () => {
    const ctx = t.app.ctx;
    const { file } = await writeProjectFile(ctx, MEMBER, PROJECT, 'race-source.txt', '原文');
    const linked = await createSource(ctx, MEMBER, PROJECT, {
      kind: 'file',
      resourceId: file.id,
      title: '并发来源',
    });
    const originalTransaction = ctx.db.db.transaction.bind(ctx.db.db);
    const spy = vi
      .spyOn(ctx.db.db, 'transaction')
      .mockImplementationOnce(async (callback, config) => {
        await updateSource(ctx, MEMBER, PROJECT, linked.id, {
          baseVersion: 1,
          citation: '人工补写书目',
        });
        return originalTransaction(callback, config);
      });
    try {
      await markSourcesForResource(ctx, MEMBER, PROJECT, 'file', file.id, false);
    } finally {
      spy.mockRestore();
    }
    const afterRace = await source(linked.id);
    expect(afterRace).toMatchObject({
      citation: '人工补写书目',
      needsReview: true,
      version: 3,
    });
    await markSourcesForResource(ctx, MEMBER, PROJECT, 'file', file.id, false);
    expect((await source(linked.id)).version).toBe(4);
  });

  it('发现待复核遇人工并发编辑时保留新内容', async () => {
    const ctx = t.app.ctx;
    const { file } = await writeProjectFile(ctx, MEMBER, PROJECT, 'race-finding.txt', '引文');
    const record = await createRecord(ctx, MEMBER, PROJECT, {
      templateId: 'rtpl_preset_general',
      title: '并发发现',
    });
    const linked = await createSource(ctx, MEMBER, PROJECT, {
      kind: 'file',
      resourceId: file.id,
      title: '发现来源',
    });
    await updateRecord(ctx, MEMBER, PROJECT, record.id, {
      baseVersion: 1,
      sourceIds: [linked.id],
    });
    const snapshot = await createSnapshot(ctx, MEMBER, PROJECT, linked.id, {
      coverage: 'complete',
    });
    const excerpt = await createExcerpt(ctx, MEMBER, PROJECT, record.id, {
      sourceId: linked.id,
      snapshotId: snapshot.id,
      quote: '引文',
      locator: { kind: 'text', paragraph: 1 },
      origin: 'observation',
    });
    const finding = await createFinding(ctx, MEMBER, PROJECT, record.id, {
      statement: '并发结论',
      supportingExcerptIds: [excerpt.id],
      humanConfirmed: true,
    });
    const originalTransaction = ctx.db.db.transaction.bind(ctx.db.db);
    const spy = vi.spyOn(ctx.db.db, 'transaction');
    spy.mockImplementationOnce((callback, config) => originalTransaction(callback, config));
    spy.mockImplementationOnce(async (callback, config) => {
      await updateFinding(ctx, MEMBER, PROJECT, finding.id, {
        baseVersion: 1,
        limitations: '人工同时补充的局限',
      });
      return originalTransaction(callback, config);
    });
    try {
      await markSourcesForResource(ctx, MEMBER, PROJECT, 'file', file.id, false);
    } finally {
      spy.mockRestore();
    }
    const afterRace = await getEntity<ResearchFinding>(ctx, PROJECT, 'finding', finding.id);
    expect(afterRace).toMatchObject({
      limitations: '人工同时补充的局限',
      needsReview: true,
      humanConfirmed: false,
      version: 3,
    });
  });
});
