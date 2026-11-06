import * as shared from '@srh/shared';
import { z } from 'zod';
import {
  SHARED_INPUT_SCHEMAS,
  TRANSFER_SCHEMAS,
  LOCAL_INPUT_SCHEMAS,
  SHARED_RESPONSES,
  LOCAL_RESPONSES,
  SHARED_ARRAY_RESPONSES,
  SHARED_PAGE_RESPONSES,
} from './catalog-schemas';
import { REVIEWED_ROUTES } from './catalog-routes';
import { LIBRARY_INTERACTIVE_ROUTES } from './catalog-library-interactive';
import { FEEDBACK_INTERACTIVE_ROUTES } from './catalog-feedback-interactive';
import { BILLING_INTERACTIVE_ROUTES } from './catalog-billing-interactive';
import { NO_CONTENT_ROUTES } from './catalog-no-content';
import { NO_QUERY_ROUTES } from './catalog-no-query';

export type OperationAccess = 'open' | 'interactive' | 'retired' | 'unclassified';
export type OperationEffect = 'read' | 'write' | 'execute';
export interface Operation {
  id: string;
  method: string;
  path: string;
  domain: string;
  access: OperationAccess;
  effect: OperationEffect;
  description: string;
  input: { params: string[]; query: unknown | null; body: unknown | null };
  response: unknown | null;
  pagination: string;
  conditions: string[];
}
export interface RouteDefinition {
  method: string | readonly string[];
  url: string;
  schema?: { params?: unknown; querystring?: unknown; body?: unknown; response?: unknown };
}

const registeredRoutes = new Set<string>([
  ...REVIEWED_ROUTES,
  ...LIBRARY_INTERACTIVE_ROUTES,
  ...FEEDBACK_INTERACTIVE_ROUTES,
  ...BILLING_INTERACTIVE_ROUTES,
]);
const prefix = '/api/v1';
const safeMethod = (method: string) => method === 'GET' || method === 'HEAD';

/** These endpoints require an interactive user even when a token has write scope. */
function interactive(method: string, path: string): boolean {
  if (LIBRARY_INTERACTIVE_ROUTES.has(`${method} ${path}`)) return true;
  if (FEEDBACK_INTERACTIVE_ROUTES.has(`${method} ${path}`)) return true;
  if (BILLING_INTERACTIVE_ROUTES.has(`${method} ${path}`)) return true;
  if (path === '/mcp') return true;
  if (/^\/auth(?:\/|$)/u.test(path) && !/^\/auth\/me(?:\/pins(?:\/|$)|$)/u.test(path)) return true;
  if (/^\/auth\/me\/tokens(?:\/|$)/u.test(path)) return true;
  if (/^\/invites(?:\/|$)/u.test(path)) return true;
  if (path === '/projects/:projectId' && method === 'DELETE') return true;
  if (/\/invites(?:\/|$)/u.test(path)) return true;
  if (/\/members(?:\/|$)/u.test(path) && method !== 'GET') return true;
  if (/\/(?:providers|mcp-servers)(?:\/|$)/u.test(path) && method !== 'GET') return true;
  if (/\/versioning\/settings$/u.test(path) && method !== 'GET') return true;
  if (/\/versioning\/github(?:\/|$)/u.test(path)) return true;
  if (/\/decisions\/[^/]+\/answer$/u.test(path)) return true;
  if (/\/reviews\/[^/]+\/(?:verdict|close)$/u.test(path)) return true;
  if (/\/proposals\/[^/]+\/(?:decisions|merge|close|decide)$/u.test(path)) return true;
  if (/\/plans\/(?:official|basis\/[^/]+\/review)$/u.test(path) && method !== 'GET') return true;
  if (/\/runs\/[^/]+\/steps\/[^/]+\/confirm$/u.test(path)) return true;
  return false;
}

function effectOf(method: string, path: string): OperationEffect {
  if (
    safeMethod(method) ||
    (method === 'POST' && /\/notebooks\/[^/]+\/(?:complete|inspect)$/u.test(path))
  )
    return 'read';
  if (method === 'POST' && /\/(?:execute|run|runs|resume|retry|compile)$/u.test(path))
    return 'execute';
  return 'write';
}

const schemaCache = new Map<string, unknown | null>();
function sharedJsonSchema(
  name: string | undefined,
  io: 'input' | 'output' = 'input',
): unknown | null {
  if (!name) return null;
  const key = `${io}:${name}`;
  if (schemaCache.has(key)) return schemaCache.get(key) ?? null;
  const value = (shared as Record<string, unknown>)[name];
  if (!(value instanceof z.ZodType)) return null;
  try {
    const schema = z.toJSONSchema(value, { io, unrepresentable: 'any' });
    // DTOs may include permission annotations in addition to their shared base shape.
    if (io === 'output' && (schema as Record<string, unknown>).type === 'object') {
      Object.assign(schema, { additionalProperties: true });
    }
    schemaCache.set(key, schema);
    return schema;
  } catch {
    schemaCache.set(key, null);
    return null;
  }
}

function createOperation(
  method: string,
  path: string,
  schema: RouteDefinition['schema'],
): Operation {
  const key = `${method} ${path}`;
  const mapped = SHARED_INPUT_SCHEMAS[key];
  const transfer = TRANSFER_SCHEMAS[key];
  const local = LOCAL_INPUT_SCHEMAS[key];
  const arrayItem = sharedJsonSchema(SHARED_ARRAY_RESPONSES[key], 'output');
  const pageItem = sharedJsonSchema(SHARED_PAGE_RESPONSES[key], 'output');
  const collectionResponse = arrayItem
    ? { type: 'array', items: arrayItem }
    : pageItem
      ? {
          type: 'object',
          required: ['items', 'nextCursor'],
          properties: {
            items: { type: 'array', items: pageItem },
            nextCursor: { type: ['string', 'null'] },
          },
        }
      : null;
  const modelCatalog = z.object({
    defaultModel: z.string(),
    defaultEffort: shared.ReasoningEffort,
    providers: z.array(shared.LlmProvider),
  });
  const modelsResult =
    key === 'GET /projects/:projectId/models'
      ? z.toJSONSchema(modelCatalog, { io: 'output', unrepresentable: 'any' })
      : null;
  const harnessResult =
    key === 'GET /projects/:projectId/harness'
      ? z.toJSONSchema(
          z.object({
            catalog: modelCatalog,
            commands: z.array(shared.SlashCommand),
            skills: z.array(shared.Skill),
            profiles: z.array(shared.AgentProfile),
          }),
          { io: 'output', unrepresentable: 'any' },
        )
      : null;
  const memoryList =
    key === 'GET /projects/:projectId/memory'
      ? z.toJSONSchema(z.array(shared.MemoryFile.omit({ content: true })), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const paperImport =
    key === 'POST /projects/:projectId/library/papers'
      ? z.toJSONSchema(z.object({ paper: shared.Paper, duplicate: z.boolean() }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const outputPage =
    key === 'GET /projects/:projectId/outputs'
      ? z.toJSONSchema(
          z.object({
            items: z.array(
              shared.OutputRef.extend({
                threadId: z.string().nullable(),
                messageId: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
          { io: 'output', unrepresentable: 'any' },
        )
      : null;
  const notebookRuns =
    key === 'POST /projects/:projectId/notebooks/:notebookId/execute'
      ? z.toJSONSchema(z.object({ runs: z.array(shared.NotebookRun) }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const notebookRestart =
    key === 'POST /projects/:projectId/notebooks/:notebookId/restart'
      ? z.toJSONSchema(z.object({ ok: z.literal(true), runs: z.array(shared.NotebookRun) }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const notebookVariables =
    key === 'GET /projects/:projectId/notebooks/:notebookId/variables'
      ? z.toJSONSchema(z.object({ variables: z.array(shared.NotebookVariable) }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const layoutResult =
    key === 'PATCH /projects/:projectId/research/records/:recordId/layout'
      ? z.toJSONSchema(z.object({ items: z.array(shared.ResearchItem) }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const reportDocument =
    key === 'POST /projects/:projectId/reports/:reportId/document'
      ? z.toJSONSchema(z.object({ report: shared.Report, document: shared.DocumentMeta }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const documentEdit =
    key === 'POST /projects/:projectId/docs/:docId/edit'
      ? z.toJSONSchema(z.object({ meta: shared.DocumentMeta, markdown: z.string() }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const documentVersion =
    key === 'GET /projects/:projectId/docs/:docId/versions/:versionId'
      ? z.toJSONSchema(z.object({ version: shared.DocumentVersion, markdown: z.string() }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const boardDetail =
    key === 'GET /projects/:projectId/boards/:boardId'
      ? z.toJSONSchema(shared.Board.extend({ cards: z.array(shared.Card) }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const notebookDetail =
    key === 'GET /projects/:projectId/notebooks/:notebookId'
      ? z.toJSONSchema(
          shared.Notebook.extend({ kernel: z.object({ status: shared.KernelStatus }) }),
          { io: 'output', unrepresentable: 'any' },
        )
      : null;
  const stopResult =
    key === 'POST /projects/:projectId/agents/:sessionId/stop'
      ? z.toJSONSchema(
          shared.AgentSession.extend({ stopped: z.enum(['turn', 'queued', 'none']) }),
          { io: 'output', unrepresentable: 'any' },
        )
      : null;
  const projectWithRole = shared.Project.extend({
    role: shared.ProjectRole,
    unread: z.number(),
    eventSeq: z.number().optional(),
  });
  const projectList =
    key === 'GET /projects'
      ? z.toJSONSchema(z.array(projectWithRole), { io: 'output', unrepresentable: 'any' })
      : null;
  const meResult =
    key === 'GET /auth/me'
      ? z.toJSONSchema(z.object({ user: shared.User, projects: z.array(projectWithRole) }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const inboxList =
    key === 'GET /inbox'
      ? z.toJSONSchema(z.array(shared.InboxItem), { io: 'output', unrepresentable: 'any' })
      : null;
  const reviewDetail =
    key === 'GET /projects/:projectId/reviews/:reviewId'
      ? z.toJSONSchema(shared.Review.extend({ comments: z.array(shared.ReviewComment) }), {
          io: 'output',
          unrepresentable: 'any',
        })
      : null;
  const columnPatch =
    key === 'PATCH /projects/:projectId/columns/:columnId'
      ? z.toJSONSchema(shared.ColumnUpsertInput.partial(), { io: 'input', unrepresentable: 'any' })
      : null;
  const access: OperationAccess = !registeredRoutes.has(key)
    ? 'unclassified'
    : interactive(method, path)
      ? 'interactive'
      : 'open';
  const segments = path.split('/').filter(Boolean);
  const domain =
    segments[0] === 'projects' ? (segments[2] ?? 'projects') : (segments[0] ?? 'other');
  return {
    id: key,
    method,
    path: prefix + path,
    domain,
    access,
    effect: effectOf(method, path),
    description: operationDescription(method, path, domain),
    input: {
      params: [...path.matchAll(/:([A-Za-z0-9_]+)/gu)]
        .map((m) => m[1]!)
        .concat(path.includes('*') ? ['*'] : []),
      query:
        schema?.querystring ??
        transfer?.query ??
        local?.query ??
        sharedJsonSchema(mapped?.query) ??
        (NO_QUERY_ROUTES.has(key)
          ? { type: 'object', properties: {}, additionalProperties: true }
          : null),
      body:
        schema?.body ??
        transfer?.body ??
        local?.body ??
        columnPatch ??
        sharedJsonSchema(mapped?.body) ??
        (method === 'GET' || method === 'DELETE'
          ? { type: 'null', description: 'No request body.' }
          : null),
    },
    response:
      schema?.response ??
      transfer?.response ??
      LOCAL_RESPONSES[key] ??
      projectList ??
      meResult ??
      inboxList ??
      modelsResult ??
      harnessResult ??
      memoryList ??
      paperImport ??
      outputPage ??
      notebookRuns ??
      notebookRestart ??
      notebookVariables ??
      layoutResult ??
      reportDocument ??
      documentEdit ??
      documentVersion ??
      boardDetail ??
      notebookDetail ??
      stopResult ??
      reviewDetail ??
      collectionResponse ??
      sharedJsonSchema(SHARED_RESPONSES[key], 'output') ??
      (NO_CONTENT_ROUTES.has(key)
        ? { type: 'null', description: 'HTTP 204, no response body.' }
        : null),
    pagination:
      key === 'GET /projects/:projectId/versions' || key === 'GET /projects/:projectId/proposals'
        ? '返回完整数组；大结果通过结果分块接口续读。'
        : key === 'GET /projects/:projectId/research/records/:recordId/workspace'
          ? 'items 和 relations 各自包含 nextCursor；使用对应列表操作分别续读。'
          : key === 'GET /projects/:projectId/research/records/:recordId/items/:itemId/content'
            ? '使用 nextOffset 作为 offset 续读，直到 nextOffset 为 null。'
            : key === 'GET /projects/:projectId/research/records/:recordId/items/:itemId/table'
              ? '使用 nextCursor 作为 cursor 继续读取表格行。'
              : key === 'GET /projects/:projectId/events'
                ? '使用 REST 响应头 X-Next-Event-Seq，或 MCP 结果的 continuation.afterSeq，作为 afterSeq 继续扫描；空的可见事件数组也可能需要续读。'
                : key === 'GET /projects/:projectId/outputs'
                  ? '使用 nextCursor 作为 cursor 续读，直到 nextCursor 为 null。'
                  : key === 'GET /projects/:projectId/docs/search'
                    ? '最多返回 20 条搜索结果，无续页游标。'
                    : key === 'GET /projects/:projectId/library/search'
                      ? '返回最多 limit 条匹配结果，无续页游标。'
                      : key === 'GET /projects' || key === 'GET /auth/me'
                        ? '返回当前用户可见项目的完整列表。'
                        : key === 'GET /inbox'
                          ? '返回完整数组；大结果通过结果分块接口续读。'
                          : pageItem
                            ? '使用 nextCursor 作为 cursor 续读，直到 nextCursor 为 null。'
                            : arrayItem
                              ? '返回完整数组，无续页游标。'
                              : key.includes('/notebooks/:notebookId/contents') ||
                                  key.includes('/notebooks/:notebookId/execution')
                                ? '使用 nextOffset 与 contentHash 续读，直到 nextOffset 为 null。'
                                : path.includes('/chunks')
                                  ? '使用 nextOffset 作为 offset 续读，直到 nextOffset 为 null。'
                                  : '分页方式尚未登记，调用方应核对返回范围。',
    conditions: [
      '令牌范围、项目成员身份及资源分享权限均生效。',
      ...(path.includes('/notebooks/') &&
      /\/(?:execute|interrupt|restart|shutdown|complete|inspect|variables|execution)$/u.test(path)
        ? ['涉及内核的执行需要服务器配置可用的 Notebook 内核；读取执行记录仍可查看已保存结果。']
        : []),
      ...(path.includes('/runs/') && path.endsWith('/confirm')
        ? ['该步骤需要网页中的人工确认。']
        : []),
      'Null schema means the route contract has not yet been registered in machine-readable form.',
      ...(key === 'POST /projects/:projectId/docs/import'
        ? [
            'MCP transfer: {encoding: base64, base64 | fileId}; the bytes must be a Yjs document update and are sent as application/octet-stream.',
          ]
        : []),
      ...([
        'POST /projects/:projectId/files',
        'POST /projects/:projectId/library/papers',
        'POST /projects/:projectId/library/papers/:paperId/pdf',
      ].includes(key)
        ? [
            'MCP transfer: {encoding: multipart, file: {filename, mimeType?, base64 | fileId}, fields?}; at most 20 MiB.',
          ]
        : []),
    ],
  };
}

const DOMAIN_NAMES: Record<string, string> = {
  projects: '项目',
  auth: '个人资料',
  inbox: '收件箱',
  integrations: '接入与文件传输',
  timeline: '项目讨论',
  messages: '消息',
  threads: '线程',
  'thread-summaries': '线程摘要',
  docs: '文档',
  files: '项目文件',
  library: '文献',
  boards: '看板',
  columns: '看板列',
  cards: '看板卡片',
  todos: '待办',
  research: '研究空间',
  notebooks: 'Notebook',
  agents: '站内 Agent',
  plans: '研究计划',
  reviews: '审阅',
  reports: '报告',
  versions: '版本',
  proposals: '改动提案',
  memory: '记忆',
  routines: '定时任务',
  claims: '资源认领',
  skills: '技能',
  profiles: 'Agent 配置',
  commands: '命令',
  shares: '资源分享',
  outputs: '产出',
  models: '模型',
  harness: 'Agent 配置',
};
function operationDescription(method: string, path: string, domain: string): string {
  if (path.endsWith('/notebooks/:notebookId/contents'))
    return '分段读取 Notebook 内容快照；续读必须携带首次返回的 contentHash。';
  if (path.endsWith('/notebooks/:notebookId/execution'))
    return '分段读取 Notebook 内核、运行状态和单元格输出。';
  if (path.endsWith('/notebooks/:notebookId/cells'))
    return '按内容哈希校验并批量插入、替换或删除 Notebook 单元格。';
  if (path.endsWith('/runs/:runId/steps/:stepId/confirm'))
    return '人工确认研究运行步骤，须在网页操作。';
  if (path.endsWith('/integrations/results/:resultId/chunks'))
    return '分段读取本令牌创建的大结果，包含 MIME、偏移和续读位置。';
  if (path.endsWith('/integrations/transfers'))
    return '开始分块上传，指定项目、路径、字节数和 SHA-256。';
  if (path.endsWith('/integrations/transfers/:transferId/chunks'))
    return '按偏移上传文件分块，重复提交相同内容可安全重试。';
  if (path.endsWith('/integrations/transfers/:transferId/complete'))
    return '校验完整性并发布已上传文件。';
  const name = DOMAIN_NAMES[domain] ?? domain;
  const parts = path.split('/').filter((p) => p && !p.startsWith(':') && p !== 'projects');
  const suffix = parts.length > 1 ? `（${parts.slice(1).join('/')}）` : '';
  const action =
    method === 'GET'
      ? '读取或列出'
      : method === 'POST'
        ? '创建或执行'
        : method === 'DELETE'
          ? '删除'
          : '更新';
  return `${action}${name}${suffix}。`;
}

export function createOperationCatalog() {
  const entries = new Map<string, Operation>();
  return {
    registerRoute(route: RouteDefinition): void {
      if (!route.url.startsWith(`${prefix}/`)) return;
      const path = route.url.slice(prefix.length);
      for (const rawMethod of typeof route.method === 'string' ? [route.method] : route.method) {
        const method = rawMethod.toUpperCase();
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        const op = createOperation(method, path, route.schema);
        entries.set(op.id, op);
      }
    },
    get(id: string): Operation | undefined {
      return entries.get(id);
    },
    getByRoute(method: string, url: string): Operation | undefined {
      const path = url.startsWith(prefix) ? url.slice(prefix.length) : url;
      return entries.get(`${method.toUpperCase()} ${path}`);
    },
    list(): Operation[] {
      return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
    coverage(): {
      unclassified: string[];
      registered: number;
      missingInput: string[];
      missingResponse: string[];
    } {
      const all = [...entries.values()];
      const open = all.filter((op) => op.access === 'open');
      return {
        unclassified: all
          .filter((op) => op.access === 'unclassified')
          .map((op) => op.id)
          .sort(),
        registered: all.length,
        missingInput: open
          .filter(
            (op) =>
              op.input.query === null ||
              (['POST', 'PUT', 'PATCH'].includes(op.method) && op.input.body === null),
          )
          .map((op) => op.id)
          .sort(),
        missingResponse: open
          .filter((op) => op.response === null)
          .map((op) => op.id)
          .sort(),
      };
    },
  };
}
export type OperationCatalog = ReturnType<typeof createOperationCatalog>;
