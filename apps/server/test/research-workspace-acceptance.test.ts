import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EvidenceExcerpt,
  ResearchItem,
  ResearchRecord,
  ResearchSnapshot,
  ResearchSource,
  Review,
} from '@srh/shared';
import { writeProjectFile } from '../src/modules/files/service';
import { collectReportContext } from '../src/modules/reports/context';
import { captureWorkspaceArchive } from '../src/modules/research/workspace-archive';
import { researchWorkspaceItems } from '../src/db/schema';
import { setupCollabApp, type CollabTestApp } from './collab/helpers';

const PID = 'prj_workspace_acceptance';
const P = `/api/v1/projects/${PID}`;
const R = `${P}/research`;
const actor = { kind: 'user' as const, id: 'usr_workspace_author', name: '研究者' };
let t: CollabTestApp;
let storage: string;
let sharedSource: ResearchSource;
let sharedSnapshot: ResearchSnapshot;
const fixtures = join(import.meta.dirname, 'fixtures/research');
const cases = [
  [
    '计算与仿真',
    'iris.csv',
    '输入数据可以关联实际计算；此处人工记录材料范围，实际内核执行由运行测试单独验证。',
  ],
  [
    '实体实验',
    'misra1a.dat',
    '保留公开实验数据及原方法说明；原始材料未提供的单位不得补造，本案例不声称重做实体实验。',
  ],
  [
    '调查与观测',
    'penguins.csv',
    '观测数据保留 NA 缺失标记和原列单位，样本范围不能解释为随机总体抽样。',
  ],
  [
    '质性研究',
    'wollstonecraft-1.txt',
    '对公开文本作片段编码与解释；作者不是访谈受试者，编码出现次数不代表主题重要性。',
  ],
  [
    '文献与史料',
    'wollstonecraft-2.txt',
    '论证使用固定版本摘录，保留作者、版本与原始行号；单段材料不足以概括全部著作。',
  ],
  [
    '理论与推导',
    'infinite-primes.lean',
    '保存命题、前提与证明文本；未运行 Lean，不声称形式验证通过。',
  ],
] as const;

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
  user = actor.id,
): Promise<T> {
  const response = await t.app.inject({
    method,
    url,
    headers: t.as(user),
    ...(payload ? { payload } : {}),
  });
  expect(response.statusCode, response.body).toBe(method === 'POST' ? 201 : 200);
  return response.json<T>();
}

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'srh-workspace-acceptance-'));
  t = await setupCollabApp({ STORAGE_DIR: storage });
  await t.seedUser(actor.id, actor.name);
  await t.seedUser('usr_workspace_reviewer', '审阅者');
  await t.seedProject(PID, actor.id);
  await t.addMember(PID, 'usr_workspace_reviewer', 'member');
}, 60_000);
afterAll(async () => {
  await t?.close();
  if (storage) await rm(storage, { recursive: true, force: true });
});

describe('研究空间公开材料任务验收（不等同真实研究者试用）', () => {
  for (const [method, file, interpretation] of cases) {
    it(`${method}：无需方法模板完成内容、依据、审阅和导出`, async () => {
      const record = await request<ResearchRecord>('POST', `${R}/workspaces`, {
        title: `${method}任务走查`,
      });
      expect(record.question).toBe('');
      const bytes = await readFile(join(fixtures, file));
      const manifest = JSON.parse(await readFile(join(fixtures, 'manifest.json'), 'utf8')) as {
        file: string;
        sha256: string;
        title: string;
      }[];
      const metadata = manifest.find((entry) => entry.file === file)!;
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.sha256);
      const written = await writeProjectFile(
        t.app.ctx,
        actor,
        PID,
        `acceptance/${file}`,
        bytes,
        file.endsWith('.csv') ? 'text/csv' : 'text/plain',
      );
      const source = await request<ResearchSource>('POST', `${R}/sources`, {
        recordId: record.id,
        kind: 'file',
        resourceId: written.file.id,
        title: metadata.title,
        citation: JSON.stringify(metadata),
      });
      const snapshot = await request<ResearchSnapshot>(
        'POST',
        `${R}/sources/${source.id}/snapshots`,
        { coverage: 'complete' },
      );
      expect(snapshot.sha256).toBe(metadata.sha256);
      const material = await request<ResearchItem>('POST', `${R}/records/${record.id}/items`, {
        kind: 'resource',
        title: metadata.title,
        evidenceRef: { kind: 'source', id: source.id },
      });
      const quote = bytes
        .toString('utf8')
        .trim()
        .split('\n')
        .find((line) => line.trim())!
        .slice(0, 150);
      const excerpt = await request<EvidenceExcerpt>('POST', `${R}/records/${record.id}/excerpts`, {
        sourceId: source.id,
        snapshotId: snapshot.id,
        quote,
        locator: { kind: 'manual', note: `${file} 中的首个非空行；手工定位` },
        origin: 'manual',
      });
      const evidence = await request<ResearchItem>('POST', `${R}/records/${record.id}/items`, {
        kind: 'resource',
        title: '工作依据',
        evidenceRef: { kind: 'excerpt', id: excerpt.id },
      });
      const note = await request<ResearchItem>('POST', `${R}/records/${record.id}/items`, {
        kind: 'note',
        title: '分析及适用限制',
        body: interpretation,
      });
      await request('POST', `${R}/records/${record.id}/relations`, {
        fromItemId: material.id,
        toItemId: evidence.id,
        label: '摘录自',
      });
      await request('POST', `${R}/records/${record.id}/relations`, {
        fromItemId: evidence.id,
        toItemId: note.id,
        label: '解释依据',
      });
      const content = await request<{ text: string }>(
        'GET',
        `${R}/records/${record.id}/items/${evidence.id}/content`,
      );
      expect(content.text).toContain(quote);
      await request('POST', `${R}/records/${record.id}/logs`, {
        body: '阅读固定原文，形成解释并明确限制。未执行的计算与实验继续保持计划状态。',
      });
      const review = await request<Review>('POST', `${P}/reviews`, {
        targetKind: 'research_record',
        targetId: record.id,
        title: `${method}任务审阅`,
        reviewerIds: ['usr_workspace_reviewer'],
      });
      expect(review.snapshot).toContain(interpretation);
      expect(review.snapshot).toContain(snapshot.id);
      expect(review.snapshot).toContain(quote);
      expect(review.snapshot).not.toContain('字段：{}');
      expect(review.snapshot).not.toContain('方法：');
      expect(review.snapshot).toContain('研究空间');
      const verdict = await t.app.inject({
        method: 'POST',
        url: `${P}/reviews/${review.id}/verdict`,
        headers: t.as('usr_workspace_reviewer'),
        payload: { verdict: 'lgtm' },
      });
      expect(verdict.statusCode, verdict.body).toBe(200);
      const exported = await request<{
        workspace: Awaited<ReturnType<typeof captureWorkspaceArchive>>;
      }>('GET', `${R}/records/${record.id}/export?format=json`);
      expect(exported.workspace.items).toContainEqual(
        expect.objectContaining({ id: note.id, body: interpretation }),
      );
      expect(exported.workspace.evidence).toContainEqual(
        expect.objectContaining({
          id: excerpt.id,
          data: expect.objectContaining({ snapshotId: snapshot.id, quote }),
        }),
      );
      for (const format of ['json', 'markdown', 'csv']) {
        const response = await t.app.inject({
          method: 'GET',
          url: `${R}/records/${record.id}/export?format=${format}`,
          headers: t.as(actor.id),
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).toContain(interpretation);
        if (format === 'markdown') {
          expect(response.body).not.toContain('## 自定义字段');
          expect(response.body).not.toContain('## 步骤');
          expect(response.body).not.toContain('- 方法：');
          expect(response.body.indexOf(interpretation)).toBeLessThan(
            response.body.indexOf('## 历史内容'),
          );
        }
        expect(response.headers['content-disposition']).toContain('attachment;');
        expect(response.headers['content-disposition']).toContain(
          `.${format === 'markdown' ? 'md' : format}"`,
        );
      }
      if (method === '文献与史料') {
        sharedSource = source;
        sharedSnapshot = snapshot;
      }
    });
  }

  it('混合研究共享固定资料；修改正文不漂移旧审阅；布局不改变内容摘要', async () => {
    const record = await request<ResearchRecord>('POST', `${R}/workspaces`, {
      title: '文本解释与资料考证共同研究',
    });
    const material = await request<ResearchItem>('POST', `${R}/records/${record.id}/items`, {
      kind: 'resource',
      title: '共用公开史料',
      evidenceRef: { kind: 'source', id: sharedSource.id },
    });
    const note = await request<ResearchItem>('POST', `${R}/records/${record.id}/items`, {
      kind: 'note',
      title: '共同分析',
      body: '共同分析旧正文：并列解释与考证，保留差异。',
    });
    const before = await captureWorkspaceArchive(t.app.ctx, PID, record.id);
    await request(
      'PATCH',
      `${R}/records/${record.id}/items/${note.id}/position`,
      { basePositionVersion: note.positionVersion, position: { x: 420, y: 160 } },
      'usr_workspace_reviewer',
    );
    const moved = await captureWorkspaceArchive(t.app.ctx, PID, record.id);
    expect(moved.contentHash).toBe(before.contentHash);
    const review = await request<Review>('POST', `${P}/reviews`, {
      targetKind: 'research_record',
      targetId: record.id,
      title: '共同报告审阅',
      reviewerIds: ['usr_workspace_reviewer'],
    });
    await request('PATCH', `${R}/records/${record.id}/items/${note.id}`, {
      baseVersion: note.version,
      body: '共同分析新正文：增加反例。',
    });
    const oldReview = await request<Review>('GET', `${P}/reviews/${review.id}`);
    expect(oldReview.snapshot).toContain('共同分析旧正文');
    expect(oldReview.snapshot).not.toContain('共同分析新正文');
    const after = await captureWorkspaceArchive(t.app.ctx, PID, record.id);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.evidence).toContainEqual(expect.objectContaining({ id: sharedSource.id }));
    expect(after.evidence).toContainEqual(expect.objectContaining({ id: sharedSnapshot.id }));
    expect(after.items.find((item) => item.id === material.id)?.resource).toBeNull();
    const context = await collectReportContext(
      t.app.ctx,
      PID,
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000),
    );
    expect(context.text).toContain('共同分析新正文');
    const hits = await request<{ items: { id: string; href: string }[] }>(
      'GET',
      `${R}/search?q=${encodeURIComponent('增加反例')}`,
    );
    expect(hits.items).toContainEqual(
      expect.objectContaining({ id: note.id, href: `/p/${PID}/research-items/${note.id}` }),
    );
    const linkedItem = await request<ResearchItem>('GET', `${R}/items/${note.id}`);
    expect(linkedItem.recordId).toBe(record.id);
  });

  it('超过 100 项时，研究内容与旧来源混合搜索分页不丢项、不重复', async () => {
    const record = await request<ResearchRecord>('POST', `${R}/workspaces`, {
      title: 'search-pagination-fixture',
    });
    const stamp = new Date();
    const rows = Array.from({ length: 105 }, (_, index) => ({
      id: `rwi_search_page_${String(index).padStart(4, '0')}`,
      projectId: PID,
      recordId: record.id,
      kind: 'note' as const,
      title: `分页固定样本 ${index}`,
      body: 'pagination-marker',
      preview: 'pagination-marker',
      resource: null,
      evidenceRef: null,
      origin: null,
      action: null,
      parentId: null,
      position: { x: 0, y: 0 },
      version: 1,
      positionVersion: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt: stamp,
      updatedAt: stamp,
    }));
    await t.db.db.insert(researchWorkspaceItems).values(rows);
    const source = await request<ResearchSource>('POST', `${R}/sources`, {
      kind: 'bibliography',
      title: 'pagination-marker 旧来源',
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ q: 'pagination-marker', limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const page = await request<{ items: { id: string }[]; nextCursor: string | null }>(
        'GET',
        `${R}/search?${query}`,
      );
      ids.push(...page.items.map((item) => item.id));
      if (page.nextCursor) expect(page.nextCursor).toBe(page.items.at(-1)!.id);
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(106);
    expect(new Set(ids)).toEqual(new Set([...rows.map((row) => row.id), source.id]));
  });
});
