import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ResearchItem,
  ResearchRecord,
  ResearchRun,
  ResearchStructuredTable,
} from '@srh/shared';
import { researchWorkspaceItems } from '../src/db/schema/research-workspace';
import { saveArtifact } from '../src/modules/research/artifacts';
import {
  setExecutionRunners,
  type ExecutionRunners,
} from '../src/modules/research/execution-runners';
import { makeApp, setupProject, sleep, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let projectId: string;
let recordId: string;
let base: string;
let generation = 0;
const runners: ExecutionRunners = {
  async selectModel() {
    return { model: 'test/model', effort: 'high', profile: null, profilePrompt: null };
  },
  async checkNotebook() {},
  async ai() {
    generation += 1;
    return {
      outputs: [
        {
          kind: 'note',
          outputKey: 'main',
          title: '结果笔记',
          content: `第 ${generation} 次生成的笔记内容。`,
          origin: 'ai_draft',
        },
        {
          kind: 'table',
          outputKey: 'table',
          title: '结果表格',
          content: `第 ${generation} 次生成的数据。`,
          origin: 'ai_draft',
          table: {
            columns: [{ id: 'amount', name: '数量', type: 'number' }],
            rows: [[7]],
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

async function runAction(itemId: string, idempotencyKey: string): Promise<ResearchRun> {
  const started = await owner.req('POST', `${base}/runs`, {
    idempotencyKey,
    steps: [{ itemId }],
  });
  expect(started.statusCode, started.body).toBe(201);
  const id = started.json<ResearchRun>().id;
  for (let i = 0; i < 600; i++) {
    const response = await owner.req('GET', `${base}/runs/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json<ResearchRun>();
    if (run.status === 'succeeded' || run.status === 'failed') {
      expect(run.status, JSON.stringify(run.steps)).toBe('succeeded');
      return run;
    }
    await sleep(20);
  }
  throw new Error('运行没有到达期望状态');
}

async function readItem(id: string): Promise<ResearchItem> {
  const response = await owner.req('GET', `${base}/items/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ResearchItem>();
}

async function move(item: ResearchItem, position: { x: number; y: number }) {
  const response = await owner.req('PATCH', `${base}/items/${item.id}/position`, {
    basePositionVersion: item.positionVersion,
    position,
  });
  expect(response.statusCode, response.body).toBe(200);
}

beforeAll(async () => {
  t = await makeApp();
  const setup = await setupProject(t.app, []);
  owner = setup.owner;
  projectId = setup.project.id;
  const record = await owner.req('POST', `/projects/${projectId}/research/workspaces`, {
    title: '产物布局继承',
  });
  expect(record.statusCode, record.body).toBe(201);
  recordId = record.json<ResearchRecord>().id;
  base = `/projects/${projectId}/research/records/${recordId}`;
  setExecutionRunners(t.app.ctx, runners);
}, 60000);

afterAll(async () => {
  await t?.close();
}, 60000);

describe('重跑产物布局', () => {
  it('按成功输出槽继承位置和有效分组，保留旧笔记与独立工作簿', async () => {
    const group = await createItem({ kind: 'group', title: '研究分组' });
    const action = await createItem({
      kind: 'action',
      title: '多输出步骤',
      action: {
        kind: 'ai',
        inputs: [],
        outputs: [
          { key: 'main', kind: 'note' },
          { key: 'table', kind: 'table' },
        ],
      },
    });
    const first = await runAction(action.id, 'output_layout_first');
    const firstOutputs = first.steps[0]!.attempts[0]!.outputs;
    const firstNote = await readItem(
      firstOutputs.find((entry) => entry.outputKey === 'main')!.itemId,
    );
    const firstTable = await readItem(
      firstOutputs.find((entry) => entry.outputKey === 'table')!.itemId,
    );
    const originalArtifact = firstOutputs.find((entry) => entry.outputKey === 'main')!.artifact!;
    const originalUrl = `/projects/${projectId}/research/artifacts/${originalArtifact.id}/download`;
    const firstArtifact = await owner.req('GET', originalUrl);
    expect(firstArtifact.statusCode, firstArtifact.body).toBe(200);
    expect(firstArtifact.body).toContain('第 1 次生成');

    const edit = await owner.req('PATCH', `${base}/items/${firstNote.id}`, {
      baseVersion: firstNote.version,
      parentId: group.id,
      body: '研究者保留的旧笔记。',
    });
    expect(edit.statusCode, edit.body).toBe(200);
    await move(firstNote, { x: 0, y: 0 });
    await move(firstTable, { x: -120, y: 244 });
    const tableEdit = await owner.req(
      'POST',
      `/projects/${projectId}/docs/${firstTable.resource!.id}/edit`,
      { op: 'set_cells', cells: [{ ref: 'A2', value: '19' }] },
    );
    expect(tableEdit.statusCode, tableEdit.body).toBe(200);

    // 未被成功尝试引用的产物即便更新，也不能决定新卡片的位置。
    const decoy = await createItem({ kind: 'note', title: '未发布结果', body: '未发布。' });
    await move(decoy, { x: 999, y: 888 });
    await saveArtifact(
      t.app.ctx,
      { kind: 'user', id: owner.user.id, name: owner.user.name },
      projectId,
      recordId,
      {
        itemId: decoy.id,
        runId: first.id,
        stepId: action.id,
        outputKey: 'main',
        kind: 'note',
        mime: 'text/plain',
        bytes: '尚未发布',
        summary: '未发布结果',
        origin: 'ai_draft',
        requestKey: 'output-layout-unpublished',
      },
    );

    const second = await runAction(action.id, 'output_layout_second');
    const secondOutputs = second.steps[0]!.attempts[0]!.outputs;
    const secondNote = await readItem(
      secondOutputs.find((entry) => entry.outputKey === 'main')!.itemId,
    );
    const secondTable = await readItem(
      secondOutputs.find((entry) => entry.outputKey === 'table')!.itemId,
    );
    expect(secondNote.id).not.toBe(firstNote.id);
    expect(secondNote.position).toEqual({ x: 0, y: 0 });
    expect(secondNote.parentId).toBe(group.id);
    expect(secondTable.id).not.toBe(firstTable.id);
    expect(secondTable.position).toEqual({ x: -120, y: 244 });
    expect(secondTable.parentId).toBeNull();
    expect(secondTable.resource?.id).not.toBe(firstTable.resource?.id);
    expect((await readItem(firstNote.id)).body).toBe('研究者保留的旧笔记。');
    expect((await owner.req('GET', originalUrl)).body).toBe(firstArtifact.body);
    const originalTable = await owner.req('GET', `${base}/items/${firstTable.id}/table`);
    const nextTable = await owner.req('GET', `${base}/items/${secondTable.id}/table`);
    expect(originalTable.statusCode, originalTable.body).toBe(200);
    expect(nextTable.statusCode, nextTable.body).toBe(200);
    const oldData = originalTable.json<ResearchStructuredTable>();
    const newData = nextTable.json<ResearchStructuredTable>();
    expect(oldData.rows[0]!.cells[oldData.columns[0]!.id]).toBe(19);
    expect(newData.rows[0]!.cells[newData.columns[0]!.id]).toBe(7);

    // 模拟父分组在产物保留后失效，仍继承坐标但回到画布根级。
    await t.app.ctx.db.db
      .update(researchWorkspaceItems)
      .set({ archivedAt: new Date() })
      .where(eq(researchWorkspaceItems.id, group.id));
    const third = await runAction(action.id, 'output_layout_third');
    const thirdOutput = third.steps[0]!.attempts[0]!.outputs.find(
      (entry) => entry.outputKey === 'main',
    )!;
    const thirdNote = await readItem(thirdOutput.itemId);
    expect(thirdNote.id).not.toBe(secondNote.id);
    expect(thirdNote.position).toEqual({ x: 0, y: 0 });
    expect(thirdNote.parentId).toBeNull();
    expect((await readItem(firstNote.id)).body).toBe('研究者保留的旧笔记。');
  }, 60000);
});
