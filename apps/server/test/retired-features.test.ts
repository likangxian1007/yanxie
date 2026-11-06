import { afterAll, beforeAll, expect, it } from 'vitest';
import { toolsFor } from '../src/agents/tools';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';
let t: TestApp;
let owner: Session;
let pid: string;
beforeAll(async () => {
  t = await makeApp();
  const project = await setupProject(t.app);
  owner = project.owner;
  pid = project.project.id;
}, 60000);
afterAll(() => t.close());
it('实验、日志、云电脑 API 和 AI 工具移除，独立 Notebook 仍可创建', async () => {
  for (const path of ['/experiments', '/experiment-logs/elg_old', '/desktop', '/desktop/start'])
    expect(
      (
        await owner.req(
          path.endsWith('/start') ? 'POST' : 'GET',
          `/projects/${pid}${path}`,
          path.endsWith('/start') ? {} : undefined,
        )
      ).statusCode,
    ).toBe(404);
  for (const role of ['coordinator', 'thread', 'personal'] as const)
    expect(
      toolsFor(t.app.ctx, role).some(
        (tool) => tool.name.includes('experiment') || tool.name.startsWith('computer_'),
      ),
    ).toBe(false);
  expect(
    (await owner.req('POST', `/projects/${pid}/notebooks`, { title: '独立 Notebook' })).statusCode,
  ).toBe(201);
  expect(
    (await owner.req('POST', `/projects/${pid}/notebooks`, { experimentId: 'exp_old' })).statusCode,
  ).toBe(422);
});
it('旧研究方法字段仅兼容接收，返回空数组', async () => {
  const res = await owner.req('PATCH', `/projects/${pid}`, {
    preferredResearchMethods: ['computational'],
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().preferredResearchMethods).toEqual([]);
});
