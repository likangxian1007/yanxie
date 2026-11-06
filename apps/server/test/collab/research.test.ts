import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  EvidenceExcerpt,
  Page,
  ResearchFinding,
  ResearchRecord,
  ResearchSnapshot,
  ResearchSource,
  ResearchTemplate,
} from '@srh/shared';
import { documents, files, papers, researchEntities } from '../../src/db/schema';
import { collectReportContext } from '../../src/modules/reports/context';
import { createFinding, createSnapshot, createSource } from '../../src/modules/research/service';
import { setupCollabApp, type CollabTestApp } from './helpers';

const PID = 'prj_research';
const OTHER = 'prj_research_other';
const base = `/api/v1/projects/${PID}/research`;
let t: CollabTestApp;
let storage: string;

async function api(
  method: string,
  url: string,
  user: string | null,
  payload?: unknown,
  key?: string,
) {
  return t.app.inject({
    method: method as 'GET',
    url,
    headers: { ...(user ? t.as(user) : {}), ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function makeRecord(
  templateId = 'rtpl_preset_general',
  title = '研究问题',
): Promise<ResearchRecord> {
  const response = await api('POST', `${base}/records`, 'usr_member', { templateId, title });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<ResearchRecord>();
}

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'srh-research-'));
  t = await setupCollabApp({ STORAGE_DIR: storage });
  for (const [id, name] of [
    ['usr_owner', '王老师'],
    ['usr_member', '张三'],
    ['usr_guest', '访客'],
    ['usr_out', '路人'],
  ] as const)
    await t.seedUser(id, name);
  await t.seedProject(PID, 'usr_owner');
  await t.seedProject(OTHER, 'usr_out');
  await t.addMember(PID, 'usr_member', 'member');
  await t.addMember(PID, 'usr_guest', 'guest');
}, 60_000);

afterAll(async () => {
  await t?.close();
  if (storage) await rm(storage, { recursive: true, force: true });
});

describe('research API', () => {
  it('只接受团队文档和论文，并在转入个人空间后停止读取新原件', async () => {
    const author = { kind: 'user' as const, id: 'usr_member', name: '张三' };
    const docId = 'doc_research_personal_boundary';
    const paperId = 'ppr_research_personal_boundary';
    await t.db.db.insert(documents).values({
      id: docId,
      projectId: PID,
      title: '个人原件',
      contentText: '个人秘密',
      ydocState: Buffer.from('个人秘密'),
      createdBy: author,
      space: 'personal',
      ownerUserId: author.id,
    });
    await t.db.db.insert(papers).values({
      id: paperId,
      projectId: PID,
      title: '个人论文',
      citekey: 'personalresearchboundary',
      source: 'upload',
      createdBy: author,
      space: 'personal',
      ownerUserId: author.id,
    });
    for (const [kind, id] of [
      ['document', docId],
      ['paper', paperId],
    ] as const) {
      const ref = { kind, id };
      const record = await api('POST', `${base}/records`, 'usr_member', {
        templateId: 'rtpl_preset_general',
        title: '不可共享个人资源',
        resources: [ref],
      });
      expect(record.statusCode, record.body).toBe(422);
      expect(record.body).toContain('团队空间');
      const source = await api('POST', `${base}/sources`, 'usr_member', {
        kind,
        resourceId: id,
        title: '不可共享个人来源',
      });
      expect(source.statusCode, source.body).toBe(422);
      await expect(
        createSource(t.app.ctx, { kind: 'agent', id: 'agt_research', name: '团队 agent' }, PID, {
          kind,
          resourceId: id,
          title: 'agent 不可共享个人来源',
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    const custom = await api('POST', `${base}/records`, 'usr_member', {
      templateId: 'rtpl_preset_qualitative',
      title: '自定义字段不可引用个人空间',
      fieldValues: { transcript: { kind: 'document', id: docId } },
    });
    expect(custom.statusCode, custom.body).toBe(422);
    expect(custom.body).toContain('团队空间');

    await t.db.db
      .update(documents)
      .set({ space: 'team', ownerUserId: null })
      .where(eq(documents.id, docId));
    await t.db.db
      .update(papers)
      .set({ space: 'team', ownerUserId: null })
      .where(eq(papers.id, paperId));
    const teamDoc = await api('POST', `${base}/sources`, 'usr_member', {
      kind: 'document',
      resourceId: docId,
      title: '团队历史文档',
    });
    const teamPaper = await api('POST', `${base}/sources`, 'usr_member', {
      kind: 'paper',
      resourceId: paperId,
      title: '团队历史论文',
    });
    expect(teamDoc.statusCode, teamDoc.body).toBe(201);
    expect(teamPaper.statusCode, teamPaper.body).toBe(201);
    const docSource = teamDoc.json<ResearchSource>();
    const paperSource = teamPaper.json<ResearchSource>();
    const oldSnapshot = await api(
      'POST',
      `${base}/sources/${docSource.id}/snapshots`,
      'usr_member',
      {
        coverage: 'complete',
      },
    );
    expect(oldSnapshot.statusCode, oldSnapshot.body).toBe(201);
    const snapshotId = oldSnapshot.json<ResearchSnapshot>().id;

    await t.db.db
      .update(documents)
      .set({
        space: 'personal',
        ownerUserId: author.id,
        contentText: '新版个人秘密',
        ydocState: Buffer.from('新版个人秘密'),
      })
      .where(eq(documents.id, docId));
    await t.db.db
      .update(papers)
      .set({ space: 'personal', ownerUserId: author.id, title: '新版个人论文' })
      .where(eq(papers.id, paperId));
    for (const source of [docSource, paperSource]) {
      const availability = await api(
        'GET',
        `${base}/sources/${source.id}/availability`,
        'usr_guest',
      );
      expect(availability.json()).toMatchObject({ available: false, reason: 'missing' });
      for (const coverage of ['complete', 'excerpt'] as const) {
        const attempt = await api('POST', `${base}/sources/${source.id}/snapshots`, 'usr_member', {
          coverage,
          ...(coverage === 'excerpt' ? { text: '新版个人秘密' } : {}),
        });
        expect(attempt.statusCode, attempt.body).toBe(422);
      }
      const edit = await api('PATCH', `${base}/sources/${source.id}`, 'usr_member', {
        baseVersion: source.version,
        title: '不能继续引用个人原件',
      });
      expect(edit.statusCode, edit.body).toBe(422);
    }
    const retained = await api('GET', `${base}/snapshots/${snapshotId}/download`, 'usr_guest');
    expect(retained.statusCode).toBe(200);
    expect(retained.rawPayload.toString('utf8')).toBe('个人秘密');
  });

  it('lists seven optional method templates and respects project permissions', async () => {
    const response = await api('GET', `${base}/templates`, 'usr_guest');
    expect(response.statusCode).toBe(200);
    const templates = response.json<Page<ResearchTemplate>>().items;
    expect(templates).toHaveLength(7);
    expect(new Set(templates.map((x) => x.method)).size).toBe(7);
    for (const template of templates) await makeRecord(template.id, `${template.name}案例`);
    expect((await api('GET', `${base}/templates`, null)).statusCode).toBe(401);
    expect((await api('GET', `${base}/templates`, 'usr_out')).statusCode).toBe(404);
    expect(
      (
        await api('POST', `${base}/records`, 'usr_guest', {
          templateId: templates[0]!.id,
          title: '不允许',
        })
      ).statusCode,
    ).toBe(403);
    expect((await api('POST', `${base}/records`, 'usr_member', { title: '' })).statusCode).toBe(
      422,
    );
  });

  it('returns frontend routes for unified records and search results', async () => {
    const record = await makeRecord('rtpl_preset_general', '链接验收');
    const source = (
      await api('POST', `${base}/sources`, 'usr_member', {
        kind: 'bibliography',
        title: '链接验收书目',
        recordId: record.id,
      })
    ).json<ResearchSource>();
    const finding = (
      await api('POST', `${base}/records/${record.id}/findings`, 'usr_member', {
        statement: '链接验收结论',
      })
    ).json<ResearchFinding>();
    const list = (await api('GET', base, 'usr_member')).json<Page<{ id: string; href: string }>>();
    expect(list.items.find((item) => item.id === record.id)?.href).toBe(
      `/p/${PID}/research/${record.id}`,
    );
    const search = (
      await api('GET', `${base}/search?q=${encodeURIComponent('链接验收')}`, 'usr_member')
    ).json<Page<{ id: string; href: string }>>();
    expect(search.items.map(({ id, href }) => ({ id, href }))).toEqual(
      expect.arrayContaining([
        { id: record.id, href: `/p/${PID}/research/${record.id}` },
        { id: source.id, href: `/p/${PID}/research-sources/${source.id}` },
        { id: finding.id, href: `/p/${PID}/research-findings/${finding.id}` },
      ]),
    );
  });

  it('keeps published template versions and record revisions immutable', async () => {
    const first = await api('POST', `${base}/templates`, 'usr_member', {
      method: 'qualitative',
      name: '访谈模板',
      fields: [{ id: 'sample', label: '样本', type: 'text', required: true, order: 0 }],
      steps: [],
    });
    expect(first.statusCode, first.body).toBe(201);
    const template = first.json<ResearchTemplate>();
    expect(
      (
        await api('POST', `${base}/records`, 'usr_member', {
          templateId: template.id,
          title: '缺样本',
        })
      ).statusCode,
    ).toBe(422);
    const created = await api('POST', `${base}/records`, 'usr_member', {
      templateId: template.id,
      title: '访谈',
      fieldValues: { sample: '三位受访者' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const record = created.json<ResearchRecord>();
    const second = await api('POST', `${base}/templates`, 'usr_member', {
      id: template.id,
      baseVersion: 1,
      method: 'qualitative',
      name: '访谈模板第二版',
      fields: [],
      steps: [],
    });
    expect(second.statusCode, second.body).toBe(201);
    const oldDetail = (await api('GET', `${base}/records/${record.id}`, 'usr_member')).json<{
      template: ResearchTemplate;
    }>();
    expect(oldDetail.template.version).toBe(1);
    const migrated = await api('PATCH', `${base}/records/${record.id}`, 'usr_member', {
      baseVersion: 1,
      migrateTemplateVersion: 2,
    });
    expect(migrated.statusCode, migrated.body).toBe(200);
    expect(migrated.json<ResearchRecord>().fieldValues.sample).toBe('三位受访者');
    expect(
      (
        await api('PATCH', `${base}/records/${record.id}`, 'usr_member', {
          baseVersion: 1,
          title: '过期写入',
        })
      ).statusCode,
    ).toBe(409);
    const revisions = (
      await api('GET', `${base}/records/${record.id}/revisions`, 'usr_member')
    ).json<Page<{ record: ResearchRecord }>>();
    expect(revisions.items.map((r) => r.record.version).sort()).toEqual([1, 2]);
  });

  it('resolves concurrent retries and version races without duplicate objects or server errors', async () => {
    const create = { templateId: 'rtpl_preset_general', title: '并发创建' };
    const same = await Promise.all([
      api('POST', `${base}/records`, 'usr_member', create, 'concurrent_record_1'),
      api('POST', `${base}/records`, 'usr_member', create, 'concurrent_record_1'),
    ]);
    expect(same.map((r) => r.statusCode)).toEqual([201, 201]);
    const record = same[0]!.json<ResearchRecord>();
    expect(same[1]!.json<ResearchRecord>().id).toBe(record.id);
    const updates = await Promise.all([
      api('PATCH', `${base}/records/${record.id}`, 'usr_member', {
        baseVersion: 1,
        title: '并发甲',
      }),
      api('PATCH', `${base}/records/${record.id}`, 'usr_member', {
        baseVersion: 1,
        title: '并发乙',
      }),
    ]);
    expect(updates.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const template = (
      await api('POST', `${base}/templates`, 'usr_member', {
        method: 'general',
        name: '并发模板',
        fields: [],
        steps: [],
      })
    ).json<ResearchTemplate>();
    const publish = (name: string) =>
      api('POST', `${base}/templates`, 'usr_member', {
        id: template.id,
        baseVersion: 1,
        method: 'general',
        name,
        fields: [],
        steps: [],
      });
    const revisions = await Promise.all([publish('版本甲'), publish('版本乙')]);
    expect(revisions.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('handles idempotency, cross-project links, shared source, snapshot drift and export', async () => {
    const body = { templateId: 'rtpl_preset_literature', title: '史料核对' };
    const a = await api('POST', `${base}/records`, 'usr_member', body, 'retry_record_1');
    const b = await api('POST', `${base}/records`, 'usr_member', body, 'retry_record_1');
    expect(a.json<ResearchRecord>().id).toBe(b.json<ResearchRecord>().id);
    expect(
      (
        await api(
          'POST',
          `${base}/records`,
          'usr_member',
          { ...body, title: '不同内容' },
          'retry_record_1',
        )
      ).statusCode,
    ).toBe(409);
    const record = a.json<ResearchRecord>();
    const another = await makeRecord('rtpl_preset_qualitative', '比较记录');
    await t.db.db.insert(files).values({
      id: 'fil_other',
      projectId: OTHER,
      path: 'other.txt',
      name: 'other.txt',
      mime: 'text/plain',
      size: 1,
      uploadedBy: { kind: 'user', id: 'usr_out', name: '路人' },
    });
    const foreign = await api('POST', `${base}/records`, 'usr_member', {
      templateId: 'rtpl_preset_general',
      title: '跨项目资源',
      resources: [{ kind: 'file', id: 'fil_other' }],
    });
    expect(foreign.statusCode).toBe(422);

    const payload = Buffer.alloc(6 * 1024 * 1024, 'x');
    await mkdir(join(storage, PID, 'uploads'), { recursive: true });
    await writeFile(join(storage, PID, 'uploads', 'source.txt'), payload);
    await t.db.db.insert(files).values({
      id: 'fil_research',
      projectId: PID,
      path: 'uploads/source.txt',
      name: 'source.txt',
      mime: 'text/plain',
      size: payload.length,
      uploadedBy: { kind: 'user', id: 'usr_member', name: '张三' },
    });
    const sourceRes = await api('POST', `${base}/sources`, 'usr_member', {
      kind: 'file',
      resourceId: 'fil_research',
      title: '原始材料',
    });
    expect(sourceRes.statusCode, sourceRes.body).toBe(201);
    const source = sourceRes.json<ResearchSource>();
    for (const r of [record, another]) {
      const updated = await api('PATCH', `${base}/records/${r.id}`, 'usr_member', {
        baseVersion: r.version,
        sourceIds: [source.id],
      });
      expect(updated.statusCode, updated.body).toBe(200);
    }
    const snapRes = await api('POST', `${base}/sources/${source.id}/snapshots`, 'usr_member', {
      coverage: 'complete',
    });
    expect(snapRes.statusCode, snapRes.body).toBe(201);
    const snapshot = snapRes.json<ResearchSnapshot>();
    expect(snapshot.byteLength).toBe(payload.length);
    expect(snapshot.coverage).toBe('complete');
    const bytes = await api('GET', `${base}/snapshots/${snapshot.id}/download`, 'usr_guest');
    expect(bytes.rawPayload.length).toBe(payload.length);
    await writeFile(join(storage, PID, 'uploads', 'source.txt'), 'new file');
    const old = await api('GET', `${base}/snapshots/${snapshot.id}/download`, 'usr_guest');
    expect(old.rawPayload.length).toBe(payload.length);
    const excerptRes = await api('POST', `${base}/records/${record.id}/excerpts`, 'usr_member', {
      sourceId: source.id,
      snapshotId: snapshot.id,
      quote: 'xxxxx',
      locator: { kind: 'text', paragraph: 1 },
      origin: 'observation',
    });
    expect(excerptRes.statusCode, excerptRes.body).toBe(201);
    const excerpt = excerptRes.json<EvidenceExcerpt>();
    expect(excerpt.snapshotId).toBe(snapshot.id);
    expect(excerpt.verification).toBe('unverified');
    const badPdfLocator = await api('POST', `${base}/records/${record.id}/excerpts`, 'usr_member', {
      sourceId: source.id,
      snapshotId: snapshot.id,
      quote: 'xxxxx',
      locator: { kind: 'pdf', page: 999 },
      origin: 'observation',
    });
    expect(badPdfLocator.json<EvidenceExcerpt>().verification).toBe('unverified');
    const badSheetLocator = await api(
      'POST',
      `${base}/records/${record.id}/excerpts`,
      'usr_member',
      {
        sourceId: source.id,
        snapshotId: snapshot.id,
        quote: 'xxxxx',
        locator: { kind: 'sheet', sheet: '不存在', range: 'Z999' },
        origin: 'observation',
      },
    );
    expect(badSheetLocator.json<EvidenceExcerpt>().verification).toBe('unverified');
    const findingRes = await api('POST', `${base}/records/${record.id}/findings`, 'usr_member', {
      statement: '存在相关材料',
      supportingExcerptIds: [excerpt.id],
      limitations: '仅一个文件',
    });
    expect(findingRes.statusCode, findingRes.body).toBe(201);
    const finding = findingRes.json<ResearchFinding>();
    expect(finding.humanConfirmed).toBe(false);
    const confirmed = await api('PATCH', `${base}/findings/${finding.id}`, 'usr_member', {
      baseVersion: 1,
      humanConfirmed: true,
    });
    expect(confirmed.json<ResearchFinding>().humanConfirmed).toBe(true);
    const changedSource = await api('PATCH', `${base}/sources/${source.id}`, 'usr_member', {
      baseVersion: 1,
      citation: '重新核对',
    });
    expect(changedSource.statusCode, changedSource.body).toBe(200);
    expect(snapshot.sourceVersion).toBe(1);
    expect(snapshot.sourceMetadata.citation).toBe('');
    const oldSnapshot = (
      await api('GET', `${base}/snapshots/${snapshot.id}`, 'usr_member')
    ).json<ResearchSnapshot>();
    expect(oldSnapshot.sourceMetadata.citation).toBe('');
    expect(oldSnapshot.sourceVersion).toBe(1);
    const needsReview = (
      await api('GET', `${base}/findings/${finding.id}`, 'usr_member')
    ).json<ResearchFinding>();
    expect(needsReview.needsReview).toBe(true);
    expect(needsReview.humanConfirmed).toBe(false);
    const stillReview = await api('PATCH', `${base}/findings/${finding.id}`, 'usr_member', {
      baseVersion: needsReview.version,
      limitations: '补写局限',
    });
    expect(stillReview.json<ResearchFinding>().needsReview).toBe(true);
    const resolved = await api('PATCH', `${base}/findings/${finding.id}`, 'usr_member', {
      baseVersion: stillReview.json<ResearchFinding>().version,
      resolveReview: true,
    });
    expect(resolved.json<ResearchFinding>().needsReview).toBe(false);
    const exported = await api(
      'GET',
      `${base}/records/${record.id}/export?format=json`,
      'usr_guest',
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.json<{ snapshots: ResearchSnapshot[] }>().snapshots[0]?.sha256).toBe(
      snapshot.sha256,
    );
    expect(
      exported.json<{ snapshots: ResearchSnapshot[] }>().snapshots[0]?.sourceMetadata.citation,
    ).toBe('');
    expect(
      (await api('GET', `${base}/snapshots/${snapshot.id}/download`, 'usr_out')).statusCode,
    ).toBe(404);
    expect(await readFile(join(storage, PID, 'uploads', 'source.txt'), 'utf8')).toBe('new file');
    await rm(join(storage, PID, 'uploads', 'source.txt'));
    expect(
      (await api('GET', `${base}/snapshots/${snapshot.id}/download`, 'usr_member')).rawPayload
        .length,
    ).toBe(payload.length);
    await expect(
      createFinding(t.app.ctx, { kind: 'agent', id: 'agt_test', name: 'Agent' }, PID, record.id, {
        statement: 'AI不应确认',
        humanConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('paginates filtered and unified lists beyond one hundred records', async () => {
    for (let i = 0; i < 105; i++)
      await makeRecord(i % 2 ? 'rtpl_preset_general' : 'rtpl_preset_theoretical', `分页 ${i}`);
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const url = `${base}/records?limit=17&method=theoretical${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await api('GET', url, 'usr_member');
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<Page<ResearchRecord>>();
      page.items.forEach((r) => seen.add(r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.size).toBeGreaterThan(50);
    const unified = await api('GET', `${base}?limit=10`, 'usr_member');
    expect(unified.statusCode).toBe(200);
    expect(unified.json<Page<{ id: string }>>().nextCursor).not.toBeNull();
  });

  it('keeps committed snapshot bytes if a post-commit callback fails', async () => {
    const sourceResponse = await api('POST', `${base}/sources`, 'usr_member', {
      kind: 'bibliography',
      title: '回调异常材料',
    });
    expect(sourceResponse.statusCode, sourceResponse.body).toBe(201);
    const source = sourceResponse.json<ResearchSource>();
    const emit = vi.spyOn(t.app.ctx.bus, 'emit').mockImplementationOnce(() => {
      throw new Error('模拟提交后的回调失败');
    });
    try {
      await expect(
        createSnapshot(
          t.app.ctx,
          { kind: 'user', id: 'usr_member', name: '张三' },
          PID,
          source.id,
          { coverage: 'excerpt', text: '不可丢失的原文' },
        ),
      ).rejects.toThrow('模拟提交后的回调失败');
    } finally {
      emit.mockRestore();
    }
    const snapshots = (
      await api('GET', `${base}/sources/${source.id}/snapshots`, 'usr_member')
    ).json<Page<ResearchSnapshot>>();
    expect(snapshots.items).toHaveLength(1);
    const download = await api(
      'GET',
      `${base}/snapshots/${snapshots.items[0]!.id}/download`,
      'usr_member',
    );
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.toString('utf8')).toBe('不可丢失的原文');
  });

  it('links a source created through the project endpoint when recordId is supplied', async () => {
    const record = await makeRecord();
    const response = await api('POST', `${base}/sources`, 'usr_member', {
      recordId: record.id,
      kind: 'bibliography',
      title: '共用书目',
    });
    expect(response.statusCode, response.body).toBe(201);
    const source = response.json<ResearchSource>();
    const detail = (await api('GET', `${base}/records/${record.id}`, 'usr_member')).json<{
      record: ResearchRecord;
      sources: ResearchSource[];
    }>();
    expect(detail.record.sourceIds).toContain(source.id);
    expect(detail.sources.map((item) => item.id)).toContain(source.id);
  });

  it('includes new findings in a report even when the record itself is old', async () => {
    const otherBase = `/api/v1/projects/${OTHER}/research`;
    const created = await api('POST', `${otherBase}/records`, 'usr_out', {
      templateId: 'rtpl_preset_theoretical',
      title: '旧理论记录',
      stepState: { step_theoretical_1: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    const record = created.json<ResearchRecord>();
    await t.db.db
      .update(researchEntities)
      .set({ createdAt: new Date('2020-01-01'), updatedAt: new Date('2020-01-01') })
      .where(eq(researchEntities.id, record.id));
    const response = await api('POST', `${otherBase}/records/${record.id}/findings`, 'usr_out', {
      statement: '本期新发现',
    });
    expect(response.statusCode, response.body).toBe(201);
    const context = await collectReportContext(
      t.app.ctx,
      OTHER,
      new Date(Date.now() - 86_400_000),
      new Date(Date.now() + 86_400_000),
    );
    expect(context.text).toContain('本期新发现');
    expect(context.text).toContain(
      'step_theoretical_1:完成 / member_report / user:路人 / unverified',
    );
    expect(context.stats.researchRecords).toBeGreaterThan(0);
  });
});
