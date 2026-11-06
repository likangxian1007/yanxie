/**
 * 真实 LLM 端到端演练（不进 CI）：
 *   pnpm --filter @srh/server e2e:agent ["自定义需求"]
 * 需要 apps/server/.env 里配置 LLM_API_KEY。用内存 PGlite，不碰本地数据。
 *
 * 流程：张三（owner）、李四（member）、王老师（advisor）加入同一项目 → 李四订阅 /ws →
 * 张三在协作台发需求 → 协调者分诊并开线程 → 线程 agent 干活、回帖 → 记忆被写入 → 打印全过程。
 */
import 'dotenv/config';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSession,
  AgentStep,
  Message,
  Page,
  Project,
  ServerFrame,
  Thread,
  User,
} from '@srh/shared';
import { startAgentRuntime } from '../src/agents/runtime';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { migrationsFolder } from '../src/db/migrate';

const ASK =
  process.argv[2] ??
  '我们组以后所有实验统一跑 3 个 seed（42、43、44），报告均值和标准差，这条请记进项目记忆。另外帮我起草一份 GraphCL 在 ogbg-molhiv 上的消融实验计划，写成项目文件 plans/ablation-graphcl.md。';
const TIMEOUT_MS = 8 * 60 * 1000;

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'pglite:memory',
  LOG_LEVEL: 'warn',
  STORAGE_DIR: mkdtempSync(join(tmpdir(), 'srh-e2e-')),
});
if (!config.llmConfigured) throw new Error('没有配置 LLM_API_KEY');
const db = await createDb(config.DATABASE_URL);
await db.migrate(migrationsFolder());
const app = await buildApp({ config, db, logger: false });
await app.ready();
const runtime = startAgentRuntime(app.ctx, { tickMs: 15_000 })!;

type Req = <T = unknown>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => Promise<T>;
async function signup(name: string): Promise<{ user: User; cookie: string; req: Req }> {
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
  return { user: res.json<User>(), cookie, req };
}

const zhang = await signup('张三');
const li = await signup('李四');
const wang = await signup('王老师');
const project = await zhang.req<Project>('POST', '/projects', {
  name: '图对比学习',
  description: '分子性质预测上的图对比学习方法研究',
});
for (const [s, role] of [
  [li, 'member'],
  [wang, 'advisor'],
] as const) {
  const inv = await zhang.req<{ token: string }>('POST', `/projects/${project.id}/invites`, {
    role,
  });
  await s.req('POST', `/invites/${inv.token}/accept`);
}

// 李四实时订阅
const frames: ServerFrame[] = [];
const ws = await app.injectWS(
  '/ws',
  { headers: { cookie: li.cookie } },
  {
    onInit: (socket) =>
      socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerFrame)),
  },
);
ws.send(JSON.stringify({ op: 'subscribe', projectId: project.id, afterSeq: 0 }));

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
log(`张三在协作台发言：${ASK}`);
await zhang.req('POST', `/projects/${project.id}/timeline`, { body: ASK });

const P = `/projects/${project.id}`;
let done = false;
while (!done && Date.now() - t0 < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, 5000));
  await runtime.idle();
  const threads = await li.req<Page<Thread>>('GET', `${P}/threads`);
  const agents = await li.req<AgentSession[]>('GET', `${P}/agents`);
  const busy = agents.some((a) => a.status === 'running' || a.status === 'queued');
  log(
    `线程 ${threads.items.length} 个；agent：${agents.map((a) => `${a.role}:${a.status}${a.activity ? `(${a.activity})` : ''}`).join(' ')}`,
  );
  if (!busy && threads.items.length > 0) {
    // 线程 agent 至少回过一次（不算 ack）
    let replied = true;
    for (const t of threads.items) {
      const msgs = await li.req<Page<Message>>('GET', `${P}/threads/${t.id}/messages?order=asc`);
      if (msgs.items.filter((m) => m.author.kind === 'agent').length < 2) replied = false;
    }
    done = replied;
  }
}

// ---------------------------------------------------------------- 输出
const out: string[] = [];
const say = (s = '') => out.push(s);
say(`# 端到端演练（${done ? '完成' : '超时'}，${((Date.now() - t0) / 1000).toFixed(0)} 秒）\n`);
say(`需求（张三）：${ASK}\n`);
const timeline = await li.req<Page<Message>>('GET', `${P}/timeline?order=asc`);
say('## 协作台');
for (const m of timeline.items)
  say(
    `- **${m.author.name}**（${m.author.kind}）${m.rootOfThreadId ? ` [线程 ${m.rootOfThreadId}]` : ''}：${m.body}`,
  );
const threads = await li.req<Page<Thread>>('GET', `${P}/threads`);
for (const t of threads.items) {
  say(
    `\n## 线程「${t.title}」 bucket=${t.statusBucket} label=${t.label ?? '-'} resolved=${t.resolved}`,
  );
  say('```\n' + t.statusText + '\n```');
  const msgs = await li.req<Page<Message>>('GET', `${P}/threads/${t.id}/messages?order=asc`);
  for (const m of msgs.items)
    say(
      `- **${m.author.name}**：${m.body}${m.outputs.length ? `  产出：${JSON.stringify(m.outputs)}` : ''}`,
    );
}
say('\n## 项目记忆');
const mem = await wang.req<{ path: string; version: number; description: string }[]>(
  'GET',
  `${P}/memory`,
);
for (const f of mem) {
  const full = await wang.req<{ content: string }>('GET', `${P}/memory/${f.path}`);
  say(`### ${f.path}（v${f.version}）${f.description}\n\n${full.content}\n`);
}
say('## 认领');
say('```json\n' + JSON.stringify(await li.req('GET', `${P}/claims`), null, 2) + '\n```');
say('## 项目文件');
const files = await li.req<{ path: string; size: number }[]>('GET', `${P}/files`);
for (const f of files) say(`- ${f.path}（${f.size} B）`);
say('\n## agent 用量与步骤（导师视角）');
const agents = await wang.req<AgentSession[]>('GET', `${P}/agents`);
for (const a of agents) {
  const steps = await wang.req<Page<AgentStep>>('GET', `${P}/agents/${a.id}/steps?limit=100`);
  const calls = steps.items.filter((s) => s.kind === 'tool_call').map((s) => s.name);
  say(
    `- ${a.role} ${a.status} tokens=${JSON.stringify(a.tokenUsage)} 工具调用：${calls.join(' → ')}`,
  );
}
const evTypes: Record<string, number> = {};
let deltas = 0;
for (const f of frames) {
  if (f.op === 'event') evTypes[f.event.type] = (evTypes[f.event.type] ?? 0) + 1;
  if (f.op === 'ephemeral') deltas += 1;
}
say(
  `\n## 李四通过 /ws 实时收到\n事件：${JSON.stringify(evTypes)}；agent.delta 流式片段：${deltas}`,
);

const report = out.join('\n');
console.log('\n' + report);
const path = process.env.E2E_OUT ?? join(tmpdir(), `srh-e2e-${Date.now()}.md`);
writeFileSync(path, report, 'utf8');
console.log(`\n记录已写入 ${path}`);
ws.terminate();
await runtime.stop();
await app.close();
await db.close();
process.exit(done ? 0 : 1);
