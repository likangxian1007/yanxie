import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ResearchItem,
  ResearchRecord,
  ResearchRun,
  ResearchStructuredTable,
} from '@srh/shared';
import { chartResearchTable, transformResearchTable } from '../src/modules/research/composable';
import { stableResearchColumnId } from '../src/modules/research/tables';
import { captureWorkspaceArchive } from '../src/modules/research/workspace-archive';
import {
  setExecutionRunners,
  type ExecutionRunners,
} from '../src/modules/research/execution-runners';
import { makeApp, setupProject, signup, sleep, type Session, type TestApp } from './helpers';

const table: ResearchStructuredTable = {
  documentId: 'doc',
  sheetId: 's1',
  sourceVersion: 'v1',
  hash: 'h1',
  nextCursor: null,
  columns: [
    { id: 'group', name: '类别' },
    { id: 'amount', name: '质量', type: 'number', unit: 'kg' },
  ],
  rows: [
    { id: 'r1', cells: { group: '甲', amount: 2 } },
    { id: 'r2', cells: { group: '甲', amount: null } },
    { id: 'r3', cells: { group: '乙', amount: 5 } },
  ],
  totalRows: 3,
};

describe('实际数据处理和图表', () => {
  it('分组统计忽略缺失而不补零，保留单位和源行', () => {
    const result = transformResearchTable(table, {
      groupBy: ['group'],
      aggregates: [
        { op: 'count', as: '行数' },
        { op: 'sum', columnId: 'amount', as: '合计' },
        { op: 'mean', columnId: 'amount', as: '平均' },
      ],
    });
    expect(result.seed.rows).toEqual([
      ['甲', 2, 2, 2],
      ['乙', 1, 5, 5],
    ]);
    expect(result.seed.columns.map((column) => column.unit)).toEqual([
      undefined,
      undefined,
      'kg',
      'kg',
    ]);
    expect(result.audit.sourceRows).toEqual([['r1', 'r2'], ['r3']]);
    expect(() =>
      transformResearchTable(
        { ...table, rows: [{ id: 'r1', cells: { group: '甲', amount: '待核对' } }], totalRows: 1 },
        { aggregates: [{ op: 'sum', columnId: 'amount', as: '合计' }] },
      ),
    ).toThrow('非数值');
  });
  it('绘图使用实际数值，明确缺失策略并拒绝不同单位', () => {
    const chart = chartResearchTable(table, {
      kind: 'bar',
      xColumn: 'group',
      yColumns: ['amount'],
      missing: 'omit',
    });
    expect(chart.plottedRows).toEqual(['r1', 'r3']);
    expect(chart.omittedRows).toBe(1);
    expect(chart.svg).toContain('质量 (kg)');
    expect(chart.svg).toContain('<rect');
    expect(() =>
      chartResearchTable(table, {
        kind: 'bar',
        xColumn: 'group',
        yColumns: ['amount'],
        missing: 'error',
      }),
    ).toThrow('缺失值');
    expect(() =>
      chartResearchTable(
        {
          ...table,
          columns: [...table.columns, { id: 'other', name: '长度', unit: 'm', type: 'number' }],
        },
        { kind: 'bar', xColumn: 'group', yColumns: ['amount', 'other'], missing: 'omit' },
      ),
    ).toThrow('单位不同');
  });
});

let t: TestApp, owner: Session, outsider: Session, projectId: string, base: string;
const calls: string[] = [];
let schemaDrift = false;
const runners: ExecutionRunners = {
  async selectModel() {
    return { model: 'test/model', effort: 'high', profile: null, profilePrompt: null };
  },
  async checkNotebook() {},
  async ai(_ctx, _projectId, _selection, input) {
    calls.push(JSON.stringify(input.inputs.map((entry) => entry.content)));
    const draft = input.inputs[0]!;
    const reordered = calls.length > 1;
    const columns = reordered
      ? [
          {
            id: 'value-v2',
            name: schemaDrift ? '质量新定义' : '质量',
            type: 'number' as const,
            unit: 'kg',
          },
          { id: 'name-v2', name: '类别', type: 'text' as const },
        ]
      : [
          { id: 'group', name: '类别', type: 'text' as const },
          { id: 'amount', name: '质量', type: 'number' as const, unit: 'kg' },
        ];
    return {
      outputs: [
        {
          kind: 'table',
          outputKey: 'extracted',
          title: '提取结果',
          content: '从原始材料提取的数据。',
          origin: 'ai_draft',
          table: {
            columns,
            rows: reordered
              ? [
                  [2, '甲'],
                  [3, '甲'],
                  [null, '乙'],
                ]
              : [
                  ['甲', 2],
                  ['甲', 3],
                  ['乙', null],
                ],
            lineage: [
              {
                rowId: 'r1',
                columnId: reordered ? 'name-v2' : 'group',
                itemId: draft.item.id,
                blockId: 'chosen',
                quote: '甲',
                verification: 'unverified',
              },
            ],
          },
        },
      ],
      logs: [],
    };
  },
  async notebook() {
    throw new Error('本测试不运行 Notebook');
  },
};
async function createItem(body: object): Promise<ResearchItem> {
  const response = await owner.req('POST', `${base}/items`, body);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<ResearchItem>();
}
async function waitRun(id: string, wanted: string[]): Promise<ResearchRun> {
  // 按截止时间轮询而不是固定次数。绘图步骤会启动 Chromium 渲染 PNG：本机不到 1 秒，
  // 但 CI 上整套测试并行时比本机慢一个数量级，冷启动可能要几十秒。
  const deadline = Date.now() + 120_000;
  let last = '';
  while (Date.now() < deadline) {
    const response = await owner.req('GET', `${base}/runs/${id}`);
    const run = response.json<ResearchRun>();
    if (wanted.includes(run.status)) return run;
    last = `${run.status}（步骤：${run.steps.map((step) => step.status).join(',')}）`;
    await sleep(50);
  }
  throw new Error(`运行状态未到达预期：期望 ${wanted.join('/')}，最后是 ${last}`);
}
beforeAll(async () => {
  t = await makeApp();
  const setup = await setupProject(t.app, []);
  owner = setup.owner;
  projectId = setup.project.id;
  outsider = await signup(t.app);
  const record = await owner.req('POST', `/projects/${projectId}/research/workspaces`, {
    title: '结构化处理',
  });
  base = `/projects/${projectId}/research/records/${record.json<ResearchRecord>().id}`;
  setExecutionRunners(t.app.ctx, runners);
}, 60000);
afterAll(async () => {
  await t?.close();
}, 60000);

describe('结构化内容与固定版本', () => {
  it('空的兼容正文不会覆盖混合草稿素材预览', async () => {
    const item = await createItem({
      kind: 'draft',
      title: '预览草稿',
      payload: { kind: 'draft', blocks: [{ id: 'a', kind: 'text', text: '原始素材' }] },
    });
    const response = await owner.req('PATCH', `${base}/items/${item.id}`, {
      baseVersion: item.version,
      body: '',
      payload: { kind: 'draft', blocks: [{ id: 'a', kind: 'text', text: '修改后的素材内容' }] },
    });
    expect(response.statusCode, response.body).toBe(200);
    const page = (await owner.req('GET', `${base}/items`)).json<{
      items: Array<{ id: string; preview: string }>;
    }>();
    expect(page.items.find((entry) => entry.id === item.id)?.preview).toContain('修改后的素材内容');
  });
  it('审阅捕获工作簿固定快照，协作编辑改变摘要而旧审阅与旧数据不漂移', async () => {
    const item = await createItem({
      kind: 'table',
      title: '审阅表',
      table: {
        columns: [{ id: 'value', name: '测量', type: 'number', unit: 'kg' }],
        rows: [[2]],
      },
    });
    const recordId = base.split('/').at(-1)!;
    const first = await captureWorkspaceArchive(t.app.ctx, projectId, recordId);
    const captured = first.currentTables.find((entry) => entry.itemId === item.id);
    expect(captured?.state).toBe('available');
    if (!captured || captured.state !== 'available') throw new Error('没有捕获表格');
    const snapshotUrl = `/projects/${projectId}/research/artifacts/${captured.artifactId}/download`;
    const fixed = await owner.req('GET', snapshotUrl);
    expect(fixed.statusCode).toBe(200);
    expect(
      JSON.parse(fixed.body).rows[0].cells[Object.keys(JSON.parse(fixed.body).rows[0].cells)[0]!],
    ).toBe(2);
    const unchanged = await captureWorkspaceArchive(t.app.ctx, projectId, recordId);
    expect(unchanged.contentHash).toBe(first.contentHash);
    expect(unchanged.currentTables.find((entry) => entry.itemId === item.id)).toEqual(captured);

    const createdReview = await owner.req('POST', `/projects/${projectId}/reviews`, {
      targetKind: 'research_record',
      targetId: recordId,
      title: '表格审阅',
      reviewerIds: [owner.user.id],
    });
    expect(createdReview.statusCode, createdReview.body).toBe(201);
    const review = createdReview.json<{ id: string; snapshot: string }>();
    expect(review.snapshot).toContain(captured.artifactId);
    expect(
      (
        await owner.req('POST', `/projects/${projectId}/docs/${item.resource!.id}/edit`, {
          op: 'set_cells',
          cells: [{ ref: 'A2', value: '9' }],
        })
      ).statusCode,
    ).toBe(200);
    const after = await captureWorkspaceArchive(t.app.ctx, projectId, recordId);
    const next = after.currentTables.find((entry) => entry.itemId === item.id);
    expect(next?.state).toBe('available');
    if (!next || next.state !== 'available') throw new Error('没有捕获更新后的表格');
    expect(after.contentHash).not.toBe(first.contentHash);
    expect(next.artifactId).not.toBe(captured.artifactId);
    expect((await owner.req('GET', snapshotUrl)).body).toBe(fixed.body);
    const currentSnapshot = await owner.req(
      'GET',
      `/projects/${projectId}/research/artifacts/${next.artifactId}/download`,
    );
    expect(Object.values(JSON.parse(currentSnapshot.body).rows[0].cells)).toEqual([9]);
    const oldReview = await owner.req('GET', `/projects/${projectId}/reviews/${review.id}`);
    expect(oldReview.json<{ snapshot: string }>().snapshot).toBe(review.snapshot);
    expect(review.snapshot).not.toContain(next.artifactId);

    expect(
      (await owner.req('DELETE', `/projects/${projectId}/docs/${item.resource!.id}`)).statusCode,
    ).toBe(204);
    const missing = await captureWorkspaceArchive(t.app.ctx, projectId, recordId);
    expect(missing.currentTables).toContainEqual(
      expect.objectContaining({ itemId: item.id, state: 'unavailable' }),
    );
    expect(missing.artifacts.map((artifact) => artifact.id)).toEqual(
      expect.arrayContaining([captured.artifactId, next.artifactId]),
    );
    expect((await owner.req('GET', snapshotUrl)).body).toBe(fixed.body);
    const exported = await owner.req('GET', `${base}/export?format=markdown`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain('当前表格不可用');
    expect(exported.body).toContain(captured.artifactId);
  }, 30000);
  it('拒绝草稿引用个人空间或其他项目的文档', async () => {
    const privateDoc = await owner.req('POST', `/projects/${projectId}/docs`, {
      kind: 'doc',
      title: '个人资料',
      space: 'personal',
    });
    expect(privateDoc.statusCode, privateDoc.body).toBe(201);
    const otherProject = await owner.req('POST', '/projects', { name: '其他项目' });
    const otherId = otherProject.json<{ id: string }>().id;
    const otherDoc = await owner.req('POST', `/projects/${otherId}/docs`, {
      kind: 'doc',
      title: '其他项目资料',
    });
    expect(otherDoc.statusCode, otherDoc.body).toBe(201);
    for (const document of [privateDoc, otherDoc]) {
      const response = await owner.req('POST', `${base}/items`, {
        kind: 'draft',
        title: '越界草稿',
        payload: {
          kind: 'draft',
          blocks: [
            {
              id: 'source',
              kind: 'resource',
              resource: { kind: 'document', id: document.json<{ id: string }>().id },
            },
          ],
        },
      });
      expect(response.statusCode).toBe(422);
    }
  });
  it('工作簿结构化分页不截断，保留稳定行列、空值与权限', async () => {
    const columns = Array.from({ length: 30 }, (_, i) => ({
      id: `col${i}`,
      name: `列${i}`,
      type: 'text',
    }));
    const rows = Array.from({ length: 205 }, (_, i) =>
      Array.from({ length: 30 }, (_unused, c) => (i === 204 && c === 29 ? '=2+2' : `${i}-${c}`)),
    );
    rows.push(Array.from({ length: 30 }, () => ''));
    const item = await createItem({ kind: 'table', title: '长表', table: { columns, rows } });
    expect(item.resource?.kind).toBe('document');
    const page = await owner.req('GET', `${base}/items/${item.id}/table?limit=200`);
    expect(page.statusCode, page.body).toBe(200);
    const first = page.json<ResearchStructuredTable>();
    expect(first.columns).toHaveLength(30);
    expect(first.totalRows).toBe(206);
    const second = (
      await owner.req('GET', `${base}/items/${item.id}/table?limit=200&cursor=${first.nextCursor}`)
    ).json<ResearchStructuredTable>();
    expect(second.rows).toHaveLength(6);
    expect(second.hash).toBe(first.hash);
    expect(second.rows[4]!.cells[second.columns[29]!.id]).toBe('=2+2');
    expect(second.rows[5]!.cells[second.columns[0]!.id]).toBeNull();
    expect([403, 404]).toContain(
      (await outsider.req('GET', `${base}/items/${item.id}/table`)).statusCode,
    );
    const csv = await owner.req('GET', `${base}/items/${item.id}/table/export`);
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain(second.columns[29]!.id);
    expect(csv.body).toContain("'=2+2");
    expect(csv.body.trimEnd().split('\r\n')).toHaveLength(207);
    expect([403, 404]).toContain(
      (await outsider.req('GET', `${base}/items/${item.id}/table/export`)).statusCode,
    );
  });
  it('选定草稿块→AI 表格→人工修改确认→分组计算，历史不漂移', async () => {
    const groupId = stableResearchColumnId({ name: '类别', type: 'text', unit: null });
    const amountId = stableResearchColumnId({ name: '质量', type: 'number', unit: 'kg' });
    const sumId = stableResearchColumnId({ op: 'sum', columnId: amountId, as: '总质量' });
    const draft = await createItem({
      kind: 'draft',
      title: '混合草稿',
      payload: {
        kind: 'draft',
        blocks: [
          { id: 'chosen', kind: 'text', text: '甲 2；甲 3；乙 缺失' },
          { id: 'excluded', kind: 'text', text: '不应传入的内容' },
        ],
      },
    });
    const ignored = await createItem({
      kind: 'note',
      title: '旧输入',
      body: '旧输入不能混入具名绑定。',
    });
    const incompatible = await owner.req('POST', `${base}/items`, {
      kind: 'action',
      title: '错误连接',
      action: {
        kind: 'ai',
        operation: 'chart',
        inputs: [{ name: '数据', source: { kind: 'item', itemId: ignored.id } }],
        outputs: [{ key: 'figure', kind: 'figure' }],
        chart: { kind: 'bar', xColumn: 'x', yColumns: ['y'], missing: 'omit' },
      },
    });
    expect(incompatible.statusCode).toBe(422);
    const extract = await createItem({
      kind: 'action',
      title: '提取',
      action: {
        kind: 'ai',
        operation: 'extract_table',
        inputItemIds: [ignored.id],
        inputs: [
          { name: '素材', source: { kind: 'item', itemId: draft.id, blockIds: ['chosen'] } },
        ],
        outputs: [{ key: 'extracted', kind: 'table' }],
      },
    });
    const human = await createItem({
      kind: 'action',
      title: '核对',
      action: {
        kind: 'human',
        inputs: [
          { name: '候选', source: { kind: 'output', stepId: extract.id, outputKey: 'extracted' } },
        ],
        outputs: [{ key: 'checked', kind: 'table' }],
      },
    });
    const transform = await createItem({
      kind: 'action',
      title: '汇总',
      action: {
        kind: 'ai',
        operation: 'transform_table',
        inputs: [
          { name: '已确认', source: { kind: 'output', stepId: human.id, outputKey: 'checked' } },
        ],
        outputs: [{ key: 'summary', kind: 'table' }],
        transform: {
          groupBy: [groupId],
          aggregates: [{ op: 'sum', columnId: amountId, as: '总质量' }],
        },
      },
    });
    const chart = await createItem({
      kind: 'action',
      title: '绘图',
      action: {
        kind: 'ai',
        operation: 'chart',
        inputs: [
          { name: '汇总', source: { kind: 'output', stepId: transform.id, outputKey: 'summary' } },
        ],
        outputs: [{ key: 'figure', kind: 'figure' }],
        chart: { kind: 'bar', xColumn: groupId, yColumns: [sumId], missing: 'omit' },
      },
    });
    const steps = [
      { itemId: extract.id },
      { itemId: human.id },
      { itemId: transform.id },
      { itemId: chart.id },
    ];
    const created = await owner.req('POST', `${base}/runs`, {
      idempotencyKey: 'composable_test_1',
      steps,
    });
    expect(created.statusCode, created.body).toBe(201);
    let run = await waitRun(created.json<ResearchRun>().id, ['waiting', 'failed']);
    expect(run.status).toBe('waiting');
    expect(calls.at(-1)).toContain('甲 2');
    expect(calls.at(-1)).not.toContain('不应传入');
    expect(calls.at(-1)).not.toContain('旧输入');
    const draftHistory = await owner.req('GET', `${base}/items/${draft.id}/artifacts`);
    expect(
      draftHistory.json<{ items: Array<{ runId: string; stepId: string | null }> }>().items,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id, stepId: null })]));
    const candidate = run.steps.find((step) => step.definition.itemId === extract.id)!.attempts[0]!
      .outputs[0]!;
    const extracted = (
      await owner.req('GET', `${base}/items/${candidate.itemId}`)
    ).json<ResearchItem>();
    expect(extracted.kind).toBe('table');
    expect(extracted.payload?.kind === 'table' && extracted.payload.lineage?.[0]).toMatchObject({
      rowId: 'r1',
      columnId: groupId,
      verification: 'matched',
    });
    const docId = extracted.resource!.id;
    expect(
      (
        await owner.req('POST', `/projects/${projectId}/docs/${docId}/edit`, {
          op: 'set_cells',
          cells: [{ ref: 'B2', value: '4' }],
        })
      ).statusCode,
    ).toBe(200);
    const forbidden = await owner.req('POST', `${base}/runs/${run.id}/steps/${human.id}/confirm`, {
      note: '核对完成',
      itemIds: [ignored.id],
    });
    expect(forbidden.statusCode).toBe(422);
    const confirmed = await owner.req('POST', `${base}/runs/${run.id}/steps/${human.id}/confirm`, {
      note: '已修正首行',
      itemIds: [candidate.itemId],
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    run = await waitRun(run.id, ['succeeded', 'failed']);
    expect(run.status, JSON.stringify(run.steps)).toBe('succeeded');
    const checked = run.steps.find((step) => step.definition.itemId === human.id)!.attempts[0]!
      .outputs[0]!;
    const summary = run.steps.find((step) => step.definition.itemId === transform.id)!.attempts[0]!
      .outputs[0]!;
    const figure = run.steps.find((step) => step.definition.itemId === chart.id)!.attempts[0]!
      .outputs[0]!;
    expect(figure.artifact?.mime).toBe('image/svg+xml');
    const figureItem = (
      await owner.req('GET', `${base}/items/${figure.itemId}`)
    ).json<ResearchItem>();
    expect(figureItem.payload?.kind === 'figure' && figureItem.payload.dataArtifactId).toBe(
      summary.artifact?.id,
    );
    const figureMetadata = (
      await owner.req('GET', `/projects/${projectId}/research/artifacts/${figure.artifact!.id}`)
    ).json<{ metadata: { pngArtifactId: string } }>();
    expect(
      (
        await owner.req(
          'GET',
          `/projects/${projectId}/research/artifacts/${figureMetadata.metadata.pngArtifactId}/download`,
        )
      ).headers['content-type'],
    ).toBe('image/png');
    const summaryTable = (
      await owner.req('GET', `${base}/items/${summary.itemId}/table`)
    ).json<ResearchStructuredTable>();
    expect(summaryTable.rows[0]!.cells[summaryTable.columns[1]!.id]).toBe(7);
    const artifactUrl = `/projects/${projectId}/research/artifacts/${checked.artifact!.id}/download`;
    const frozenBefore = await owner.req('GET', artifactUrl);
    expect(frozenBefore.statusCode).toBe(200);
    expect(JSON.parse(frozenBefore.body).rows[0].cells[amountId]).toBe(4);
    expect(
      (await owner.req('GET', `${base}/runs/${run.id}/staleness`)).json<{ stale: boolean }>().stale,
    ).toBe(false);
    await owner.req('POST', `/projects/${projectId}/docs/${docId}/edit`, {
      op: 'set_cells',
      cells: [{ ref: 'B2', value: '9' }],
    });
    expect((await owner.req('GET', artifactUrl)).body).toBe(frozenBefore.body);
    const stale = (await owner.req('GET', `${base}/runs/${run.id}/staleness`)).json<{
      stale: boolean;
      inputs: Array<{ itemId: string; state: string }>;
    }>();
    expect(stale.stale).toBe(true);
    expect(stale.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: candidate.itemId, state: 'changed' }),
      ]),
    );
    const versions = await owner.req('GET', `${base}/items/${candidate.itemId}/artifacts`);
    expect(
      versions.json<{ items: Array<{ origin: string }> }>().items.map((entry) => entry.origin),
    ).toEqual(expect.arrayContaining(['ai_draft', 'member_report']));
    const exported = await owner.req('GET', `${base}/export?format=markdown`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain('甲 2；甲 3；乙 缺失');
    expect(exported.body).toContain(`步骤 ${extract.id} 的 extracted`);
    expect(exported.body).toContain('固定产物与下载');
    expect(exported.body).toContain(checked.artifact!.id);
    const researchCsv = await owner.req('GET', `${base}/export?format=csv`);
    expect(researchCsv.body).toContain(`/items/${candidate.itemId}/table/export`);
    const second = await owner.req('POST', `${base}/runs`, {
      idempotencyKey: 'composable_test_2',
      steps,
    });
    expect(second.statusCode, second.body).toBe(201);
    let rerun = await waitRun(second.json<ResearchRun>().id, ['waiting', 'failed']);
    expect(rerun.status, JSON.stringify(rerun.steps)).toBe('waiting');
    const candidate2 = rerun.steps.find((step) => step.definition.itemId === extract.id)!
      .attempts[0]!.outputs[0]!;
    const item2 = (
      await owner.req('GET', `${base}/items/${candidate2.itemId}`)
    ).json<ResearchItem>();
    const table2 = (
      await owner.req('GET', `${base}/items/${candidate2.itemId}/table`)
    ).json<ResearchStructuredTable>();
    expect(table2.columns.map((column) => column.id)).toEqual([amountId, groupId]);
    await owner.req('POST', `/projects/${projectId}/docs/${item2.resource!.id}/edit`, {
      op: 'set_cells',
      cells: [{ ref: 'A2', value: '6' }],
    });
    expect(
      (
        await owner.req('POST', `${base}/runs/${rerun.id}/steps/${human.id}/confirm`, {
          note: '重新核对',
          itemIds: [candidate2.itemId],
        })
      ).statusCode,
    ).toBe(200);
    rerun = await waitRun(rerun.id, ['succeeded', 'failed']);
    expect(rerun.status, JSON.stringify(rerun.steps)).toBe('succeeded');
    const result2 = rerun.steps.find((step) => step.definition.itemId === transform.id)!
      .attempts[0]!.outputs[0]!;
    const grouped2 = (
      await owner.req('GET', `${base}/items/${result2.itemId}/table`)
    ).json<ResearchStructuredTable>();
    expect(grouped2.rows[0]!.cells[sumId]).toBe(9);
    expect((await owner.req('GET', artifactUrl)).body).toBe(frozenBefore.body);
    schemaDrift = true;
    const third = await owner.req('POST', `${base}/runs`, {
      idempotencyKey: 'composable_test_3',
      steps: [{ itemId: extract.id }],
    });
    expect(third.statusCode, third.body).toBe(201);
    const failed = await waitRun(third.json<ResearchRun>().id, ['failed', 'succeeded']);
    expect(failed.status).toBe('failed');
    expect(failed.steps[0]!.attempts[0]!.error).toContain('重新配置下游列映射');
    schemaDrift = false;
  }, 400000);
});
