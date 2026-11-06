import { render } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { Providers } from '@/app/providers';
import { routes } from '@/app/router';
import { tr } from '@/lib/i18n';

/** 外壳级测试（命令面板、移动端抽屉）共用：假的后端 + 完整路由。 */

export const PID = 'prj_01JBTEST000000000000000000';
const NOW = '2026-10-26T08:00:00.000Z';

export const USER = {
  id: 'usr_01JBTEST000000000000000001',
  email: 'kk@lab.edu.cn',
  name: 'kk',
  avatarColor: 0,
  avatarUrl: null,
  createdAt: NOW,
};

export const MENTOR = {
  id: 'usr_01JBTEST000000000000000002',
  email: 'wang@lab.edu.cn',
  name: tr('王老师'),
  avatarColor: 3,
  avatarUrl: null,
  createdAt: NOW,
};

const PROJECT = {
  id: PID,
  name: tr('扩散模型医学分割'),
  description: '',
  icon: '🧬',
  color: 0,
  instructions: '',
  visibility: 'team',
  createdBy: USER.id,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

export const DOC_HIT = {
  id: 'doc_01JBTEST000000000000000001',
  kind: 'doc',
  title: tr('文献综述'),
  snippet: tr('MedSegDiff 与 nnU-Net 的对比'),
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 输入框 / 命令面板用的 harness 汇总（只放面板用到的字段） */
export const HARNESS = {
  catalog: { providers: [] },
  skills: [
    {
      id: 'skl_1',
      slug: 'exp-card',
      name: tr('实验卡'),
      description: tr('把一次实验整理成卡片'),
      scope: 'project',
    },
  ],
  commands: [
    { id: 'builtin:stop', name: 'stop', description: tr('停下'), scope: 'builtin' },
    { id: 'cmd_1', name: 'weekly', description: tr('写本周周报'), scope: 'project' },
  ],
  profiles: [],
};

export const MCP_SERVERS = [
  {
    id: 'mcp_1',
    projectId: PID,
    scope: 'project',
    ownerUserId: null,
    name: 'arxiv-search',
    description: tr('检索 arXiv'),
    transport: 'http',
    command: '',
    args: [],
    envKeys: [],
    url: 'https://example.com/mcp',
    headerKeys: [],
    enabled: true,
    disabledTools: [],
    roles: ['coordinator', 'thread', 'personal'],
    state: 'ready',
    error: null,
    tools: [],
    createdBy: { kind: 'user', id: 'usr_x', name: tr('测试') },
    createdAt: NOW,
    updatedAt: NOW,
  },
];

export interface FakeBackendOptions {
  /** 文档搜索接口的返回：'missing' 模拟 404 */
  docSearch?: 'ok' | 'missing';
  researchHits?: {
    kind: 'record' | 'source' | 'finding';
    id: string;
    title: string;
    snippet: string;
    recordId: string | null;
  }[];
}

/** 装上假的 fetch / WebSocket，返回 fetch mock（可以断言请求）。 */
export function installFakeBackend({
  docSearch = 'ok',
  researchHits = [],
}: FakeBackendOptions = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname;
    if (p === '/api/health')
      return json({
        status: 'ok',
        version: '0.1.0',
        uptimeSec: 1,
        time: NOW,
        db: { ok: true, driver: 'pglite', latencyMs: 1 },
        llm: { configured: false, model: '' },
      });
    if (p === '/api/v1/auth/me')
      return json({ user: USER, projects: [{ ...PROJECT, role: 'owner' }] });
    if (p === `/api/v1/projects/${PID}`) return json(PROJECT);
    if (p.endsWith('/members'))
      return json([
        { projectId: PID, user: USER, role: 'owner', joinedAt: NOW },
        { projectId: PID, user: MENTOR, role: 'advisor', joinedAt: NOW },
      ]);
    if (p === `/api/v1/projects/${PID}/docs/search`) {
      if (docSearch === 'missing')
        return json({ error: { code: 'not_found', message: tr('接口不存在') } }, 404);
      const q = url.searchParams.get('q') ?? '';
      return json(DOC_HIT.title.includes(q) || DOC_HIT.snippet.includes(q) ? [DOC_HIT] : []);
    }
    if (p === `/api/v1/projects/${PID}/research/search`)
      return json({
        items: researchHits.map((hit) => ({ ...hit, projectId: PID, href: '' })),
        nextCursor: null,
      });
    const findingId = p.match(
      new RegExp(`^/api/v1/projects/${PID}/research/findings/([^/]+)$`, 'u'),
    )?.[1];
    if (findingId)
      return json({ recordId: researchHits.find((hit) => hit.id === findingId)?.recordId });
    if (p === `/api/v1/projects/${PID}/research/records/rrc_a`)
      return json({ error: { code: 'not_found', message: tr('测试记录未加载') } }, 404);
    if (p.endsWith('/agents') || p.endsWith('/claims') || p === '/api/v1/inbox') return json([]);
    if (p === `/api/v1/projects/${PID}/harness`) return json(HARNESS);
    if (p === `/api/v1/projects/${PID}/mcp-servers`) return json(MCP_SERVERS);
    return json({ items: [], nextCursor: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'WebSocket',
    class {
      static OPEN = 1;
      readyState = 0;
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    },
  );
  return fetchMock;
}

/** 在 StrictMode 下渲染完整应用（和 main.tsx 一样）。 */
export function renderShell(path = `/p/${PID}`) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <StrictMode>
      <Providers queryClient={queryClient}>
        <RouterProvider router={router} />
      </Providers>
    </StrictMode>,
  );
  return { ...view, router };
}
