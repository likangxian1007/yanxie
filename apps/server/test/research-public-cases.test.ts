import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EvidenceExcerpt,
  Page,
  ResearchCode,
  ResearchFinding,
  ResearchRecord,
  ResearchSnapshot,
  ResearchSource,
  Review,
} from '@srh/shared';
import { writeProjectFile } from '../src/modules/files/service';
import { setupCollabApp, type CollabTestApp } from './collab/helpers';

const PID = 'prj_public_cases';
const P = `/api/v1/projects/${PID}`;
const R = `${P}/research`;
const fixtureDir = fileURLToPath(new URL('./fixtures/research/', import.meta.url));
const actor = { kind: 'user' as const, id: 'usr_author', name: '案例研究者' };
let t: CollabTestApp;
let storage: string;
interface Provenance {
  file: string;
  title: string;
  url: string;
  retrievedAt: string;
  sha256: string;
  upstreamSha256: string;
  originalArchive?: string;
  license: string;
}
let manifest: Provenance[];

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
  user = actor.id,
): Promise<T> {
  const response = await t.app.inject({
    method,
    url,
    headers: t.as(user),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  expect(response.statusCode, response.body).toBe(method === 'POST' ? 201 : 200);
  return response.json<T>();
}
async function text(file: string) {
  return readFile(join(fixtureDir, file), 'utf8');
}
async function createRecord(method: string, title: string) {
  return request<ResearchRecord>('POST', `${R}/records`, {
    templateId: `rtpl_preset_${method}`,
    title,
    question: title,
  });
}
async function source(file: string) {
  const provenance = manifest.find((p) => p.file === file)!;
  const bytes = await readFile(join(fixtureDir, file));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.sha256);
  const written = await writeProjectFile(
    t.app.ctx,
    actor,
    PID,
    `public/${file}`,
    bytes,
    file.endsWith('.csv') ? 'text/csv' : 'text/plain',
  );
  const material = await request<ResearchSource>('POST', `${R}/sources`, {
    kind: 'file',
    resourceId: written.file.id,
    title: provenance.title,
    citation: JSON.stringify(provenance),
    url: provenance.url,
  });
  const snapshot = await request<ResearchSnapshot>(
    'POST',
    `${R}/sources/${material.id}/snapshots`,
    { coverage: 'complete' },
  );
  expect(snapshot.sha256).toBe(provenance.sha256);
  const download = await t.app.inject({
    method: 'GET',
    url: `${R}/snapshots/${snapshot.id}/download`,
    headers: t.as(actor.id),
  });
  expect(download.statusCode).toBe(200);
  expect(download.rawPayload.equals(bytes)).toBe(true);
  return { material, snapshot };
}
async function excerpt(
  record: ResearchRecord,
  material: ResearchSource,
  snapshot: ResearchSnapshot,
  quote: string,
  manual = false,
) {
  return request<EvidenceExcerpt>('POST', `${R}/records/${record.id}/excerpts`, {
    sourceId: material.id,
    snapshotId: snapshot.id,
    quote,
    locator: manual
      ? { kind: 'manual', note: '原始文件中逐字检索此片段；未验证表格坐标/页码' }
      : { kind: 'text', paragraph: 1 },
    origin: 'manual',
  });
}
async function finish(
  record: ResearchRecord,
  evidence: EvidenceExcerpt[],
  statement: string,
  limitations: string,
) {
  await request('POST', `${R}/records/${record.id}/logs`, { body: statement });
  const finding = await request<ResearchFinding>('POST', `${R}/records/${record.id}/findings`, {
    statement,
    supportingExcerptIds: evidence.map((e) => e.id),
    limitations,
  });
  expect(finding.humanConfirmed).toBe(false);
  const completed = await request<ResearchRecord>('PATCH', `${R}/records/${record.id}`, {
    baseVersion: record.version,
    status: 'completed',
  });
  const review = await request<Review>('POST', `${P}/reviews`, {
    targetKind: 'research_record',
    targetId: record.id,
    title: `复核：${record.title}`,
    summary: '公开资料演示案例；检查版本及来源，不表示研究结论普遍成立',
    reviewerIds: ['usr_reviewer'],
  });
  const verdict = await t.app.inject({
    method: 'POST',
    url: `${P}/reviews/${review.id}/verdict`,
    headers: t.as('usr_reviewer'),
    payload: { verdict: 'lgtm' },
  });
  expect(verdict.statusCode, verdict.body).toBe(200);
  const exported = await request<{
    record: ResearchRecord;
    sources: ResearchSource[];
    snapshots: ResearchSnapshot[];
    excerpts: EvidenceExcerpt[];
    findings: ResearchFinding[];
  }>('GET', `${R}/records/${record.id}/export?format=json`);
  expect(exported.record.version).toBe(completed.version);
  expect(exported.findings).toContainEqual(
    expect.objectContaining({ id: finding.id, limitations, humanConfirmed: false }),
  );
  for (const e of evidence) {
    expect(exported.excerpts).toContainEqual(
      expect.objectContaining({ id: e.id, snapshotId: e.snapshotId }),
    );
    expect(exported.snapshots.some((s) => s.id === e.snapshotId)).toBe(true);
    expect(exported.sources.some((s) => s.id === e.sourceId)).toBe(true);
  }
  for (const format of ['markdown', 'csv']) {
    const out = await t.app.inject({
      method: 'GET',
      url: `${R}/records/${record.id}/export?format=${format}`,
      headers: t.as(actor.id),
    });
    expect(out.statusCode, out.body).toBe(200);
    expect(out.body).toContain(evidence[0]!.snapshotId);
  }
  // 后续编辑不改变旧审阅绑定的证据版本。
  await request('PATCH', `${R}/records/${record.id}`, {
    baseVersion: completed.version,
    title: `${record.title}（后续记录）`,
  });
  const reviewed = await request<Review>('GET', `${P}/reviews/${review.id}`);
  expect(reviewed.snapshot).toBe(review.snapshot);
  return finding;
}
async function link(record: ResearchRecord, material: ResearchSource, related?: ResearchRecord) {
  return request<ResearchRecord>('PATCH', `${R}/records/${record.id}`, {
    baseVersion: record.version,
    sourceIds: [material.id],
    resources: related ? [{ kind: 'research', id: related.id }] : [],
  });
}

beforeAll(async () => {
  manifest = JSON.parse(await text('manifest.json')) as Provenance[];
  for (const entry of manifest) {
    if (!entry.originalArchive) continue;
    const original = gunzipSync(await readFile(join(fixtureDir, entry.originalArchive)));
    expect(createHash('sha256').update(original).digest('hex')).toBe(entry.upstreamSha256);
  }
  storage = await mkdtemp(join(tmpdir(), 'srh-public-cases-'));
  t = await setupCollabApp({ STORAGE_DIR: storage });
  await t.seedUser(actor.id, actor.name);
  await t.seedUser('usr_reviewer', '案例复核者');
  await t.seedProject(PID, actor.id);
  await t.addMember(PID, 'usr_reviewer', 'member');
}, 60_000);
afterAll(async () => {
  await t?.close();
  if (storage) await rm(storage, { recursive: true, force: true });
});

describe('public research cases: offline evidence → analysis → review → export', () => {
  it('computational: executes a fixed Iris nearest-centroid comparison and preserves input/configuration', async () => {
    const rows = (await text('iris.csv'))
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => {
        const cells = line.split(',');
        return { x: cells.slice(0, 4).map(Number), label: cells[4]! };
      });
    const training = rows.filter((_, i) => i % 5 !== 0);
    const testing = rows.filter((_, i) => i % 5 === 0);
    const centroids = [...new Set(training.map((row) => row.label))].map((label) => {
      const group = training.filter((row) => row.label === label);
      return {
        label,
        x: [0, 1, 2, 3].map((i) => group.reduce((sum, row) => sum + row.x[i]!, 0) / group.length),
      };
    });
    const correct = testing.filter(
      (row) =>
        [...centroids].sort(
          (a, b) =>
            a.x.reduce((sum, v, i) => sum + (v - row.x[i]!) ** 2, 0) -
            b.x.reduce((sum, v, i) => sum + (v - row.x[i]!) ** 2, 0),
        )[0]!.label === row.label,
    ).length;
    expect([rows.length, training.length, testing.length, correct]).toEqual([150, 120, 30, 29]);
    const { material, snapshot } = await source('iris.csv');
    let record = await link(
      await createRecord('computational', 'Iris 最近质心分类的固定划分表现'),
      material,
    );
    record = await request('PATCH', `${R}/records/${record.id}`, {
      baseVersion: record.version,
      fieldValues: {
        configuration: '原始行号从0起；i%5=0测试，其余训练；四维原值欧氏距离；无调参',
        execution: 'Vitest 本文件中的 TypeScript 运算已执行',
      },
    });
    // 保存本次实际执行的测试源码，配置、输入及实现均可回溯，避免只留下路径说明。
    const implementation = await readFile(fileURLToPath(import.meta.url));
    const { file: codeFile } = await writeProjectFile(
      t.app.ctx,
      actor,
      PID,
      'public/executed-public-cases.ts',
      implementation,
      'text/plain',
    );
    const codeSource = await request<ResearchSource>('POST', `${R}/sources`, {
      kind: 'file',
      resourceId: codeFile.id,
      title: '本次实际执行的公开案例测试源码',
      citation: '项目测试代码；通过 Vitest 执行，快照为本次运行读取的源文件。',
    });
    const codeSnapshot = await request<ResearchSnapshot>(
      'POST',
      `${R}/sources/${codeSource.id}/snapshots`,
      { coverage: 'complete' },
    );
    expect(codeSnapshot.sha256).toBe(createHash('sha256').update(implementation).digest('hex'));
    record = await request('PATCH', `${R}/records/${record.id}`, {
      baseVersion: record.version,
      sourceIds: [material.id, codeSource.id],
      resources: [{ kind: 'file', id: codeFile.id }],
      fieldValues: {
        ...record.fieldValues,
        input: { kind: 'file', id: material.resourceId },
        code: { kind: 'file', id: codeFile.id },
      },
    });
    const e = await excerpt(record, material, snapshot, '5.1,3.5,1.4,0.2,Iris-setosa', true);
    await finish(
      record,
      [e],
      `实际执行：训练${training.length}条，测试${testing.length}条，命中${correct}条。实现：apps/server/test/research-public-cases.test.ts。`,
      '仅固定划分演示，未经交叉验证，不推论总体泛化性能；输入保留历史数据。',
    );
  });

  it('experimental: preserves reported observations, unspecified units, and certified model conditions', async () => {
    const raw = await text('misra1a.dat');
    const observations = raw
      .split('Data:   y               x')[1]!
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).map(Number));
    const rss = observations.reduce(
      (sum, [y, x]) => sum + (y! - 238.94212918 * (1 - Math.exp(-0.00055015643181 * x!))) ** 2,
      0,
    );
    expect(observations).toHaveLength(14);
    expect(rss).toBeCloseTo(0.12455138894, 8);
    const { material, snapshot } = await source('misra1a.dat');
    let record = await link(
      await createRecord('experimental', 'NIST 单分子吸附观测的模型残差复核'),
      material,
    );
    record = await request('PATCH', `${R}/records/${record.id}`, {
      baseVersion: record.version,
      fieldValues: {
        samples: '原文14条观测，按原始行号编号；未提供实体样品ID',
        conditions: '响应为体积、预测变量为压力；来源未给单位，不隐式换算',
        deviations: '这是公开实验报告复核，不是本平台实施的新实验；原始仪器方法未公开完整步骤',
      },
    });
    await finish(
      record,
      [await excerpt(record, material, snapshot, '10.07E0      77.6E0', true)],
      `以来源给出的 b1=238.94212918、b2=0.00055015643181 代入 y=b1*(1-exp(-b2*x))，本测试实际计算 RSS=${rss}，与来源参考值一致。`,
      '未重新拟合参数，未复现实验；单位、样品及仪器条件未完整提供。',
    );
  });

  it('observational: retains missing values and millimetres in a descriptive estimate', async () => {
    const rows = (await text('penguins.csv'))
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split(','));
    const values = rows
      .map((row) => row[4]!)
      .filter((v) => v !== 'NA')
      .map(Number);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    expect([rows.length, values.length]).toEqual([344, 342]);
    expect(mean).toBeCloseTo(200.91520467836258, 10);
    const { material, snapshot } = await source('penguins.csv');
    let record = await link(await createRecord('observational', '企鹅鳍长的描述统计'), material);
    record = await request('PATCH', `${R}/records/${record.id}`, {
      baseVersion: record.version,
      fieldValues: {
        variables: 'flipper_length_mm：鳍长，毫米；NA为缺失',
        cleaning: '仅此变量的均值排除2个NA，不删除原始行，不作单位转换',
        sampleSize: { value: 344, unit: '条' },
      },
    });
    await finish(
      record,
      [await excerpt(record, material, snapshot, 'flipper_length_mm', true)],
      `实际执行：344条观测，鳍长有效342条，缺失2条，均值${mean} mm。`,
      '跨物种合并的描述统计；不代表物种差异或因果关系。',
    );
  });

  it('qualitative and literature: share a fixed source across methods, code by object, and revisit original text', async () => {
    const { material, snapshot } = await source('wollstonecraft-1.txt');
    const q = await link(
      await createRecord('qualitative', '公开文本中的自主性与服从主题'),
      material,
    );
    const quote = 'Strengthen the female mind by enlarging it';
    const qe = await excerpt(q, material, snapshot, quote);
    expect(qe.verification).toBe('verified');
    const code = await request<ResearchCode>('POST', `${R}/records/${q.id}/codes`, {
      name: '自主性',
      definition: '通过教育形成判断能力',
      group: '教育与主体性',
    });
    await request('POST', `${R}/records/${q.id}/codings`, {
      excerptId: qe.id,
      codeId: code.id,
      caseId: 'public-text-paragraph-1',
    });
    const byCase = await request<Page<{ codeId: string }>>(
      'GET',
      `${R}/records/${q.id}/codings?caseId=public-text-paragraph-1`,
    );
    expect(byCase.items.map((c) => c.codeId)).toEqual([code.id]);
    await request('PATCH', `${R}/codes/${code.id}`, {
      baseVersion: code.version,
      definition: '以文段中扩大心智及减少盲从为识别依据；不以出现频次判断重要性',
    });
    await finish(
      q,
      [qe],
      '此公开文段将扩大心智与减少盲从关联，可编码为自主性主题。',
      '演示研究者解释，非访谈或真实受访者记录；单段编码频次不能代表重要性。',
    );
    const literature = await link(
      await createRecord('literature', '教育与自主权论证的文本考证'),
      material,
      q,
    );
    const le = await excerpt(literature, material, snapshot, quote);
    const second = await source('wollstonecraft-2.txt');
    const combined = await request<ResearchRecord>('PATCH', `${R}/records/${literature.id}`, {
      baseVersion: literature.version,
      sourceIds: [material.id, second.material.id],
      fieldValues: {
        search: '在固定公开版本中人工检索 mind、power；登记两处原文位置',
        screening: '纳入讨论教育与自主的两段；未称穷尽检索',
        edition: 'Project Gutenberg #3420；获取日与内容hash见来源登记',
        sourceCriticism: '第二段包含作者转引Rousseau，未核对Rousseau原版，不能当作已确认的一手原文',
      },
    });
    const secondExcerpt = await excerpt(
      combined,
      second.material,
      second.snapshot,
      'I do not wish them to have power over men; but over themselves.',
    );
    await finish(
      combined,
      [le, secondExcerpt],
      '两处段落共同支持作者强调判断能力与自我支配的解释；共同报告关联质性编码记录和文献考证记录。',
      '仅两个选段，转引尚待考证；未概括整部著作，也未将解释写为实际观测。',
    );
    expect(le.snapshotId).toBe(qe.snapshotId);
    expect(le.sourceId).toBe(qe.sourceId);
    await request('PATCH', `${R}/sources/${material.id}`, {
      baseVersion: material.version,
      citation: `${material.citation}\n补充版本说明`,
    });
    for (const record of [q, combined]) {
      const findings = await request<Page<ResearchFinding>>(
        'GET',
        `${R}/records/${record.id}/findings`,
      );
      expect(findings.items.every((f) => f.needsReview)).toBe(true);
      const excerpts = await request<Page<EvidenceExcerpt>>(
        'GET',
        `${R}/records/${record.id}/excerpts`,
      );
      expect(excerpts.items.find((e) => e.sourceId === material.id)?.snapshotId).toBe(snapshot.id);
    }
  });

  it('theoretical: records explicit domain, reasoning, and the absence of local prover verification', async () => {
    const { material, snapshot } = await source('infinite-primes.lean');
    let record = await link(
      await createRecord('theoretical', '素数无穷性的前提及论证结构'),
      material,
    );
    record = await request('PATCH', `${R}/records/${record.id}`, {
      baseVersion: record.version,
      fieldValues: {
        definitions: 'Nat.Prime，定义域为自然数',
        assumptions: '依赖 mathlib 的自然数整除及阶乘性质；固定版本见来源',
        statement: '任意自然数n存在p≥n且p为素数',
        derivation: '考虑 n!+1 的素因子，利用整除性质排除 p≤n',
        verification: '已登记固定版本证明源文件；本测试未执行 Lean，不能标记机器验证通过',
      },
    });
    await finish(
      record,
      [await excerpt(record, material, snapshot, 'theorem exists_infinite_primes', true)],
      '论证记录：对任意自然数界n，以n!+1的素因子构造大于n的素数；参考固定版本mathlib证明。',
      '只保存与阅读证明文本，未运行形式化证明器；依赖前提及库版本须由审阅者检查。',
    );
  });
});
