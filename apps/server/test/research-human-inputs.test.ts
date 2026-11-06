import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ResearchItem,
  ResearchItemSummary,
  ResearchRecord,
  ResearchRun,
  ResearchRunOutput,
  ResearchStructuredTable,
} from '@srh/shared';
import { saveArtifact } from '../src/modules/research/artifacts';
import { confirmStep } from '../src/modules/research/execution';
import {
  setExecutionRunners,
  type ExecutionRunners,
} from '../src/modules/research/execution-runners';
import { makeApp, setupProject, sleep, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let foreignOwner: Session;
let projectId: string;
let recordId: string;
let base: string;
let foreignBase: string;

const runners: ExecutionRunners = {
  async selectModel() {
    return { model: 'test/model', effort: 'high', profile: null, profilePrompt: null };
  },
  async checkNotebook() {},
  async ai() {
    return {
      outputs: [
        {
          kind: 'table',
          outputKey: 'extracted',
          title: '候选数据',
          content: '原始材料中提取的候选数据。',
          origin: 'ai_draft',
          table: {
            columns: [
              { id: 'group', name: '组别', type: 'text' },
              { id: 'amount', name: '数量', type: 'number' },
            ],
            rows: [
              ['甲', 1],
              ['甲', 2],
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

async function start(itemId: string, idempotencyKey: string): Promise<ResearchRun> {
  const response = await owner.req('POST', `${base}/runs`, {
    idempotencyKey,
    steps: [{ itemId }],
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<ResearchRun>();
}

async function waitRun(id: string, statuses: string[]): Promise<ResearchRun> {
  for (let i = 0; i < 600; i++) {
    const response = await owner.req('GET', `${base}/runs/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json<ResearchRun>();
    if (statuses.includes(run.status)) return run;
    await sleep(20);
  }
  throw new Error('运行没有到达期望状态');
}

function output(run: ResearchRun, itemId: string): ResearchRunOutput {
  const step = run.steps.find((entry) => entry.definition.itemId === itemId);
  const result = step?.attempts.findLast((attempt) => attempt.status === 'succeeded')?.outputs[0];
  if (!result?.artifact) throw new Error(`步骤 ${itemId} 没有固定输出`);
  return result;
}

async function tableArtifact(artifactId: string): Promise<ResearchStructuredTable> {
  const response = await owner.req(
    'GET',
    `/projects/${projectId}/research/artifacts/${artifactId}/download`,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ResearchStructuredTable>();
}

async function editCell(item: ResearchItem, value: string) {
  const response = await owner.req(
    'POST',
    `/projects/${projectId}/docs/${item.resource!.id}/edit`,
    {
      op: 'set_cells',
      cells: [{ ref: 'B2', value }],
    },
  );
  expect(response.statusCode, response.body).toBe(200);
}

beforeAll(async () => {
  t = await makeApp();
  const setup = await setupProject(t.app, []);
  owner = setup.owner;
  projectId = setup.project.id;
  const record = await owner.req('POST', `/projects/${projectId}/research/workspaces`, {
    title: '人工确认固定输入',
  });
  expect(record.statusCode, record.body).toBe(201);
  recordId = record.json<ResearchRecord>().id;
  base = `/projects/${projectId}/research/records/${recordId}`;

  const foreign = await setupProject(t.app, []);
  foreignOwner = foreign.owner;
  const foreignRecord = await foreignOwner.req(
    'POST',
    `/projects/${foreign.project.id}/research/workspaces`,
    { title: '另一项目' },
  );
  expect(foreignRecord.statusCode, foreignRecord.body).toBe(201);
  foreignBase = `/projects/${foreign.project.id}/research/records/${foreignRecord.json<ResearchRecord>().id}`;
  setExecutionRunners(t.app.ctx, runners);
}, 60000);

afterAll(async () => {
  await t?.close();
}, 60000);

describe('人工确认已绑定固定输入', () => {
  it('历史上游单步确认修改后的表格，并为后续计算固定当时的数据', async () => {
    const material = await createItem({
      kind: 'note',
      title: '原始材料',
      body: '甲 1；甲 2。',
    });
    const extraction = await createItem({
      kind: 'action',
      title: '提取数据',
      action: {
        kind: 'ai',
        operation: 'extract_table',
        inputs: [{ name: '材料', source: { kind: 'item', itemId: material.id } }],
        outputs: [{ key: 'extracted', kind: 'table' }],
      },
    });
    const extractedRun = await start(extraction.id, 'human_history_extract');
    const extracted = await waitRun(extractedRun.id, ['succeeded', 'failed']);
    expect(extracted.status, JSON.stringify(extracted.steps)).toBe('succeeded');
    const extractedOutput = output(extracted, extraction.id);
    const original = await tableArtifact(extractedOutput.artifact!.id);
    const groupId = original.columns.find((column) => column.name === '组别')!.id;
    const amountId = original.columns.find((column) => column.name === '数量')!.id;
    expect(original.rows.map((row) => row.cells[amountId])).toEqual([1, 2]);

    const unpublished = await saveArtifact(
      t.app.ctx,
      { kind: 'user', id: owner.user.id, name: owner.user.name },
      projectId,
      recordId,
      {
        itemId: extractedOutput.itemId,
        runId: extracted.id,
        stepId: extraction.id,
        outputKey: 'extracted',
        kind: 'table',
        mime: 'application/json',
        bytes: JSON.stringify(original),
        summary: '尚未发布的尝试',
        origin: 'ai_draft',
        requestKey: 'human-input-test-unpublished',
      },
    );
    const rejectUnpublished = await owner.req('POST', `${base}/items`, {
      kind: 'action',
      title: '不能绑定未发布版本',
      action: {
        kind: 'human',
        inputs: [
          {
            name: '候选',
            source: {
              kind: 'output',
              stepId: extraction.id,
              outputKey: 'extracted',
              artifactVersionId: unpublished.id,
            },
          },
        ],
        outputs: [{ key: 'checked', kind: 'table' }],
      },
    });
    expect(rejectUnpublished.statusCode, rejectUnpublished.body).toBe(422);

    const human = await createItem({
      kind: 'action',
      title: '单独人工检查',
      action: {
        kind: 'human',
        inputs: [
          {
            name: '候选',
            source: {
              kind: 'output',
              stepId: extraction.id,
              outputKey: 'extracted',
              artifactVersionId: extractedOutput.artifact!.id,
            },
          },
        ],
        outputs: [{ key: 'checked', kind: 'table' }],
      },
    });
    const started = await start(human.id, 'human_history_confirm');
    const waiting = await waitRun(started.id, ['waiting', 'failed']);
    expect(waiting.status, JSON.stringify(waiting.steps)).toBe('waiting');
    expect(waiting.steps[0]!.definition.dependsOn).toEqual([]);

    const summaries = await owner.req('GET', `${base}/items?limit=100`);
    expect(summaries.statusCode, summaries.body).toBe(200);
    const summaryItems = summaries.json<{ items: ResearchItemSummary[] }>().items;

    const unrelated = await createItem({
      kind: 'table',
      title: '未绑定的表格',
      table: { columns: [{ id: 'v', name: '值', type: 'number' }], rows: [[10]] },
    });
    const foreignResponse = await foreignOwner.req('POST', `${foreignBase}/items`, {
      kind: 'note',
      title: '另一项目的内容',
      body: '不可作为本研究的确认内容。',
    });
    expect(foreignResponse.statusCode, foreignResponse.body).toBe(201);
    const foreignItem = foreignResponse.json<ResearchItem>();
    for (const id of [unrelated.id, foreignItem.id]) {
      const denied = await owner.req(
        'POST',
        `${base}/runs/${waiting.id}/steps/${human.id}/confirm`,
        {
          note: '核对',
          itemIds: [id],
        },
      );
      expect(denied.statusCode, denied.body).toBe(422);
    }
    const outsider = await foreignOwner.req(
      'POST',
      `${base}/runs/${waiting.id}/steps/${human.id}/confirm`,
      { note: '越权', itemIds: [extractedOutput.itemId] },
    );
    expect([403, 404]).toContain(outsider.statusCode);
    await expect(
      confirmStep(
        t.app.ctx,
        { kind: 'agent', id: 'agent_a', name: '研协' },
        projectId,
        recordId,
        waiting.id,
        human.id,
        { note: '代签', itemIds: [extractedOutput.itemId] },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const candidateResponse = await owner.req('GET', `${base}/items/${extractedOutput.itemId}`);
    expect(candidateResponse.statusCode, candidateResponse.body).toBe(200);
    const candidate = candidateResponse.json<ResearchItem>();
    await editCell(candidate, '4');
    const confirmed = await owner.req(
      'POST',
      `${base}/runs/${waiting.id}/steps/${human.id}/confirm`,
      {
        note: '已把首个值更正为 4。',
        itemIds: [candidate.id],
      },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const done = await waitRun(waiting.id, ['succeeded', 'failed']);
    expect(done.status, JSON.stringify(done.steps)).toBe('succeeded');
    expect(done.steps[0]!.confirmedBy?.id).toBe(owner.user.id);
    const checked = output(done, human.id);
    expect(checked.outputKey).toBe('checked');
    expect(checked.origin).toBe('member_report');
    expect(
      (await tableArtifact(checked.artifact!.id)).rows.map((row) => row.cells[amountId]),
    ).toEqual([4, 2]);
    expect(
      (await tableArtifact(extractedOutput.artifact!.id)).rows.map((row) => row.cells[amountId]),
    ).toEqual([1, 2]);
    const currentAfterConfirm = await owner.req('GET', `${base}/runs/${done.id}/staleness`);
    expect(currentAfterConfirm.statusCode, currentAfterConfirm.body).toBe(200);
    expect(currentAfterConfirm.json()).toMatchObject({
      stale: false,
      inputs: [{ itemId: candidate.id, state: 'current' }],
    });

    await editCell(candidate, '9');
    const changedAfterConfirm = await owner.req('GET', `${base}/runs/${done.id}/staleness`);
    expect(changedAfterConfirm.statusCode, changedAfterConfirm.body).toBe(200);
    expect(changedAfterConfirm.json()).toMatchObject({
      stale: true,
      inputs: [{ itemId: candidate.id, state: 'changed' }],
    });
    const transform = await createItem({
      kind: 'action',
      title: '统计确认结果',
      action: {
        kind: 'ai',
        operation: 'transform_table',
        inputs: [
          {
            name: '已确认',
            source: {
              kind: 'output',
              stepId: human.id,
              outputKey: 'checked',
              artifactVersionId: checked.artifact!.id,
            },
          },
        ],
        outputs: [{ key: 'summary', kind: 'table' }],
        transform: {
          groupBy: [groupId],
          aggregates: [{ op: 'sum', columnId: amountId, as: '合计' }],
        },
      },
    });
    const summaryRun = await start(transform.id, 'human_history_transform');
    const summaryDone = await waitRun(summaryRun.id, ['succeeded', 'failed']);
    expect(summaryDone.status, JSON.stringify(summaryDone.steps)).toBe('succeeded');
    const summaryOutput = output(summaryDone, transform.id);
    const summary = await tableArtifact(summaryOutput.artifact!.id);
    const totalId = summary.columns.find((column) => column.name === '合计')!.id;
    expect(summary.rows[0]!.cells[totalId]).toBe(6);
    expect((await tableArtifact(checked.artifact!.id)).rows[0]!.cells[amountId]).toBe(4);

    // 并行的自动步骤仍消费原先固定的版本，人工确认不能替它消除过期状态。
    const mixedResponse = await owner.req('POST', `${base}/runs`, {
      idempotencyKey: 'human_history_other_branch',
      steps: [{ itemId: human.id }, { itemId: transform.id }],
    });
    expect(mixedResponse.statusCode, mixedResponse.body).toBe(201);
    const mixed = await waitRun(mixedResponse.json<ResearchRun>().id, ['waiting', 'failed']);
    expect(mixed.status, JSON.stringify(mixed.steps)).toBe('waiting');
    expect(mixed.steps.find((step) => step.definition.itemId === transform.id)?.status).toBe(
      'succeeded',
    );
    const mixedConfirm = await owner.req(
      'POST',
      `${base}/runs/${mixed.id}/steps/${human.id}/confirm`,
      {
        note: '确认当前表格。',
        itemIds: [candidate.id],
      },
    );
    expect(mixedConfirm.statusCode, mixedConfirm.body).toBe(200);
    const mixedDone = await waitRun(mixed.id, ['succeeded', 'failed']);
    expect(mixedDone.status, JSON.stringify(mixedDone.steps)).toBe('succeeded');
    const mixedStale = await owner.req('GET', `${base}/runs/${mixed.id}/staleness`);
    expect(mixedStale.statusCode, mixedStale.body).toBe(200);
    expect(mixedStale.json()).toMatchObject({
      stale: true,
      inputs: [{ itemId: candidate.id, state: 'changed' }],
    });
    expect(summaryItems.find((item) => item.id === extraction.id)?.runStatus).toBe('succeeded');
    expect(summaryItems.find((item) => item.id === human.id)?.runStatus).toBe('waiting');
    const producer = summaryItems.find((item) => item.id === extractedOutput.itemId);
    expect(producer?.producerStepId).toBe(extraction.id);
    expect(producer?.producerOutputKey).toBe('extracted');
  }, 60000);

  it('直接绑定的笔记和表格可以确认，具名输入不回退到未绑定的旧输入', async () => {
    const note = await createItem({ kind: 'note', title: '绑定笔记', body: '核对前的笔记。' });
    const ignored = await createItem({ kind: 'note', title: '旧输入', body: '不能被确认。' });
    const table = await createItem({
      kind: 'table',
      title: '绑定表格',
      table: {
        columns: [
          { id: 'group', name: '组别', type: 'text' },
          { id: 'amount', name: '数量', type: 'number' },
        ],
        rows: [['甲', 1]],
      },
    });
    const human = await createItem({
      kind: 'action',
      title: '检查直接输入',
      action: {
        kind: 'human',
        inputItemIds: [ignored.id],
        inputs: [
          { name: '笔记', source: { kind: 'item', itemId: note.id } },
          { name: '表格', source: { kind: 'item', itemId: table.id } },
        ],
        outputs: [
          { key: 'checked_note', kind: 'note' },
          { key: 'checked_table', kind: 'table' },
        ],
      },
    });
    const started = await start(human.id, 'human_direct_confirm');
    const waiting = await waitRun(started.id, ['waiting', 'failed']);
    expect(waiting.status, JSON.stringify(waiting.steps)).toBe('waiting');
    expect(waiting.inputSnapshots.map((snapshot) => snapshot.item.id).sort()).toEqual(
      [note.id, table.id].sort(),
    );
    const denied = await owner.req('POST', `${base}/runs/${waiting.id}/steps/${human.id}/confirm`, {
      note: '核对',
      itemIds: [ignored.id, table.id],
    });
    expect(denied.statusCode, denied.body).toBe(422);
    const edit = await owner.req('PATCH', `${base}/items/${note.id}`, {
      baseVersion: note.version,
      body: '人工修订后的笔记。',
    });
    expect(edit.statusCode, edit.body).toBe(200);
    await editCell(table, '7');
    const confirmed = await owner.req(
      'POST',
      `${base}/runs/${waiting.id}/steps/${human.id}/confirm`,
      {
        note: '已检查直接输入。',
        itemIds: [note.id, table.id],
      },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const done = await waitRun(waiting.id, ['succeeded', 'failed']);
    expect(done.status, JSON.stringify(done.steps)).toBe('succeeded');
    const outputs = done.steps[0]!.attempts[0]!.outputs;
    expect(outputs.map((entry) => entry.outputKey)).toEqual(['checked_note', 'checked_table']);
    const noteSnapshot = await owner.req(
      'GET',
      `/projects/${projectId}/research/artifacts/${outputs[0]!.artifact!.id}/download`,
    );
    expect(noteSnapshot.statusCode, noteSnapshot.body).toBe(200);
    expect(noteSnapshot.body).toBe('人工修订后的笔记。');
    const fixedTable = await tableArtifact(outputs[1]!.artifact!.id);
    expect(fixedTable.rows[0]!.cells[fixedTable.columns[1]!.id]).toBe(7);
    const currentAfterConfirm = await owner.req('GET', `${base}/runs/${done.id}/staleness`);
    expect(currentAfterConfirm.statusCode, currentAfterConfirm.body).toBe(200);
    expect(currentAfterConfirm.json()).toMatchObject({
      stale: false,
      inputs: expect.arrayContaining([
        expect.objectContaining({ itemId: note.id, state: 'current' }),
        expect.objectContaining({ itemId: table.id, state: 'current' }),
      ]),
    });
    await editCell(table, '8');
    const changedAfterConfirm = await owner.req('GET', `${base}/runs/${done.id}/staleness`);
    expect(changedAfterConfirm.statusCode, changedAfterConfirm.body).toBe(200);
    expect(changedAfterConfirm.json()).toMatchObject({
      stale: true,
      inputs: expect.arrayContaining([
        expect.objectContaining({ itemId: table.id, state: 'changed' }),
      ]),
    });
  }, 60000);

  it('直接输入被其他自动分支消费时，人工确认不掩盖该分支的旧快照', async () => {
    const table = await createItem({
      kind: 'table',
      title: '共享输入表',
      table: {
        columns: [
          { id: 'group', name: '组别', type: 'text' },
          { id: 'amount', name: '数量', type: 'number' },
        ],
        rows: [['甲', 1]],
      },
    });
    const tableResponse = await owner.req('GET', `${base}/items/${table.id}/table`);
    expect(tableResponse.statusCode, tableResponse.body).toBe(200);
    const amount = tableResponse.json<ResearchStructuredTable>().columns[1]!.id;
    const human = await createItem({
      kind: 'action',
      title: '确认共享输入',
      action: {
        kind: 'human',
        inputs: [{ name: '数据', source: { kind: 'item', itemId: table.id } }],
        outputs: [{ key: 'checked', kind: 'table' }],
      },
    });
    const automatic = await createItem({
      kind: 'action',
      title: '统计共享输入',
      action: {
        kind: 'ai',
        operation: 'transform_table',
        inputs: [{ name: '数据', source: { kind: 'item', itemId: table.id } }],
        outputs: [{ key: 'summary', kind: 'table' }],
        transform: { aggregates: [{ op: 'sum', columnId: amount, as: '合计' }] },
      },
    });
    const response = await owner.req('POST', `${base}/runs`, {
      idempotencyKey: 'human_direct_other_branch',
      steps: [{ itemId: human.id }, { itemId: automatic.id }],
    });
    expect(response.statusCode, response.body).toBe(201);
    const waiting = await waitRun(response.json<ResearchRun>().id, ['waiting', 'failed']);
    expect(waiting.status, JSON.stringify(waiting.steps)).toBe('waiting');
    expect(waiting.steps.find((step) => step.definition.itemId === automatic.id)?.status).toBe(
      'succeeded',
    );
    await editCell(table, '4');
    const confirmed = await owner.req(
      'POST',
      `${base}/runs/${waiting.id}/steps/${human.id}/confirm`,
      {
        note: '确认当前表格。',
        itemIds: [table.id],
      },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const done = await waitRun(waiting.id, ['succeeded', 'failed']);
    expect(done.status, JSON.stringify(done.steps)).toBe('succeeded');
    const stale = await owner.req('GET', `${base}/runs/${done.id}/staleness`);
    expect(stale.statusCode, stale.body).toBe(200);
    expect(stale.json()).toMatchObject({
      stale: true,
      inputs: [{ itemId: table.id, state: 'changed' }],
    });
  }, 60000);

  it('旧行动没有具名输入时仍可确认 inputItemIds 中的固定笔记', async () => {
    const note = await createItem({ kind: 'note', title: '旧版输入', body: '需要检查的笔记。' });
    const human = await createItem({
      kind: 'action',
      title: '兼容旧版输入',
      action: {
        kind: 'human',
        inputItemIds: [note.id],
        outputs: [{ key: 'checked', kind: 'note' }],
      },
    });
    const started = await start(human.id, 'human_legacy_confirm');
    const waiting = await waitRun(started.id, ['waiting', 'failed']);
    expect(waiting.status, JSON.stringify(waiting.steps)).toBe('waiting');
    const confirmed = await owner.req(
      'POST',
      `${base}/runs/${waiting.id}/steps/${human.id}/confirm`,
      {
        note: '已检查旧版输入。',
        itemIds: [note.id],
      },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const done = await waitRun(waiting.id, ['succeeded', 'failed']);
    expect(done.status, JSON.stringify(done.steps)).toBe('succeeded');
    expect(output(done, human.id)).toMatchObject({
      itemId: note.id,
      outputKey: 'checked',
      origin: 'member_report',
    });
  }, 60000);
});
