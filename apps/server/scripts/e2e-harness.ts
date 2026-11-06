/**
 * harness 能力的真实 LLM 演练（不进 CI）：
 *   pnpm --filter @srh/server e2e:harness
 * 需要 apps/server/.env 里的 LLM_API_KEY，以及能运行 npx（拉官方 filesystem MCP 服务器）。
 * 用内存 PGlite，不碰本地数据。结果写到 E2E_OUT（默认临时目录）下的 harness-e2e.json。
 *
 * 1. 第二个 provider「ds2」（同一个 DeepSeek 地址，另一个 id）经 LLM_PROVIDERS 注入，验证路由
 * 2. 负责人添加项目级 MCP：官方 @modelcontextprotocol/server-filesystem，指向一个放了论文摘要的目录
 * 3. 成员在个人会话发 /plan（斜杠指令）→ agent 只出计划
 * 4. 切到 ds2/deepseek-v4-pro + 强度 max → 让 agent 精读目录里的论文：应当 load_skill + 调 MCP 读文件
 * 5. 切回 deepseek-flash + 强度 off → 再问一句，检查步骤里记录的模型与强度确实变了
 */
import 'dotenv/config';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSession,
  AgentStep,
  McpServer,
  Message,
  Page,
  Project,
  Thread,
  User,
} from '@srh/shared';
import { startAgentRuntime } from '../src/agents/runtime';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { migrationsFolder } from '../src/db/migrate';

const OUT = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), 'srh-harness-e2e-'));
const papers = join(OUT, 'papers');
mkdirSync(papers, { recursive: true });
writeFileSync(
  join(papers, 'graphcl-abstract.md'),
  [
    '# Graph Contrastive Learning with Augmentations (GraphCL, NeurIPS 2020)',
    '',
    'Abstract. Generalizable, transferrable, and robust representation learning on graph-structured data remains a challenge for GNNs.',
    'We develop a graph contrastive learning framework (GraphCL) for learning unsupervised representations of graph data.',
    'We design four types of graph augmentations: node dropping, edge perturbation, attribute masking and subgraph sampling.',
    'We systematically study the impact of various combinations of augmentations on multiple datasets, in four different settings:',
    'semi-supervised, unsupervised, transfer learning and adversarial attacks. Results show that, even without tuning augmentation',
    'extents nor using sophisticated GNN architectures, GraphCL can produce graph representations of similar or better',
    'generalizability, transferrability, and robustness compared to state-of-the-art methods.',
    '',
    'Key table: on ogbg-molhiv transfer, GraphCL ROC-AUC 75.99±0.65 vs. no-pretrain 75.3±1.9 (10 seeds).',
  ].join('\n'),
);

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'pglite:memory',
  LOG_LEVEL: 'warn',
  STORAGE_DIR: mkdtempSync(join(tmpdir(), 'srh-e2e-')),
  MCP_ALLOW_STDIO: 'true',
  LLM_PROVIDERS: JSON.stringify([
    {
      id: 'ds2',
      name: 'DeepSeek（第二入口）',
      baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
      apiKeyEnv: 'LLM_API_KEY',
      models: ['deepseek-v4-pro'],
    },
  ]),
});
if (!config.llmConfigured) throw new Error('没有配置 LLM_API_KEY');
const db = await createDb(config.DATABASE_URL);
await db.migrate(migrationsFolder());
const app = await buildApp({ config, db, logger: false });
await app.ready();
const runtime = startAgentRuntime(app.ctx, { tickMs: 15_000 })!;

type Req = <T = unknown>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: unknown,
) => Promise<T>;
async function signup(name: string): Promise<{ user: User; req: Req }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: `${Date.now()}${Math.random()}@e2e.local`, name, password: 'password123' },
  });
  const raw = res.headers['set-cookie'];
  const cookie = ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0]!;
  const req: Req = async (method, url, body) => {
    const r = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return (r.body ? r.json() : null) as never;
  };
  return { user: res.json<User>(), req };
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const zhang = await signup('张三');
const li = await signup('李四');
const project = await zhang.req<Project>('POST', '/projects', {
  name: '图对比学习',
  description: '分子性质预测上的图对比学习',
});
const inv = await zhang.req<{ token: string }>('POST', `/projects/${project.id}/invites`, {
  role: 'member',
});
await li.req('POST', `/invites/${inv.token}/accept`);
const P = `/projects/${project.id}`;

log('添加 filesystem MCP …');
const mcp = await zhang.req<McpServer>('POST', `${P}/mcp-servers`, {
  scope: 'project',
  name: 'fs',
  description: '课题组共享的论文目录（只读用途）',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', papers],
});
log('MCP 状态', mcp.state, mcp.error ?? '', mcp.tools.map((t) => t.exposedName).join(', '));
if (mcp.state !== 'ready') throw new Error('MCP 没连上');

async function waitIdle(sessionId: string, timeoutMs = 6 * 60_000) {
  const start = Date.now();
  for (;;) {
    await runtime.idle();
    const s = await li.req<AgentSession>('GET', `${P}/agents/${sessionId}`);
    if (s.status !== 'running' && s.status !== 'queued') return s;
    if (Date.now() - start > timeoutMs) throw new Error('超时');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
async function turnSteps(sessionId: string) {
  const page = await li.req<Page<AgentStep>>(
    'GET',
    `${P}/agents/${sessionId}/steps?limit=100&order=desc`,
  );
  const lastTurn = page.items[0]?.turnId;
  return page.items.filter((s) => s.turnId === lastTurn).reverse();
}
const summarize = (steps: AgentStep[]) =>
  steps.map((s) => ({
    kind: s.kind,
    name: s.name,
    model: (s.data as Record<string, unknown> | null)?.model,
    effort: (s.data as Record<string, unknown> | null)?.effort,
    content: s.content.slice(0, 300),
  }));

const report: Record<string, unknown> = { mcpTools: mcp.tools.map((t) => t.exposedName) };

// 3. /plan
const thread = await li.req<Thread>('POST', `${P}/threads`, {
  body: '/plan 评估 GraphCL 在我们分子数据集上值不值得复现',
});
await runtime.idle();
const agents = await li.req<AgentSession[]>('GET', `${P}/agents`);
const session = agents.find((a) => a.threadId === thread.id)!;
log('个人会话', session.id, session.model, session.effort);
await waitIdle(session.id);
report.plan = summarize(await turnSteps(session.id));
log('/plan 完成');

// 4. 切模型 + 强度，精读论文
await li.req('PATCH', `${P}/agents/${session.id}/settings`, {
  model: 'ds2/deepseek-v4-pro',
  effort: 'max',
  profile: 'paper-reader',
});
await li.req('POST', `${P}/threads/${thread.id}/messages`, {
  body: '先不用执行计划。共享论文目录里有一篇 GraphCL 的摘要，请按精读流程拆解它，告诉我证据强度如何。',
});
await runtime.idle();
await waitIdle(session.id);
const read = await turnSteps(session.id);
report.deepRead = summarize(read);
log(
  '精读完成；工具：',
  read
    .filter((s) => s.kind === 'tool_call')
    .map((s) => s.name)
    .join(', '),
);

// 5. 切回 flash + off
await li.req('PATCH', `${P}/agents/${session.id}/settings`, {
  model: 'deepseek/deepseek-flash',
  effort: 'off',
});
await li.req('POST', `${P}/threads/${thread.id}/messages`, { body: '一句话：这篇值得复现吗？' });
await runtime.idle();
await waitIdle(session.id);
report.switchBack = summarize(await turnSteps(session.id));

const msgs = await li.req<Page<Message>>(
  'GET',
  `${P}/threads/${thread.id}/messages?order=asc&limit=100`,
);
report.messages = msgs.items.map((m) => ({ author: m.author.name, body: m.body.slice(0, 1500) }));
writeFileSync(join(OUT, 'harness-e2e.json'), JSON.stringify(report, null, 2));
log('结果写到', join(OUT, 'harness-e2e.json'));
await runtime.stop();
await app.close();
await db.close();
process.exit(0);
