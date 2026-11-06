import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { McpState, McpToolInfo } from '@srh/shared';
import type { AppContext } from '../../context';
import { mcpServers } from '../../db/schema';
import { describeMcpError, mcpFetch } from '../../modules/harness/mcp-net';
import {
  defineTool,
  ToolError,
  type SessionRow,
  type ThreadRow,
  type ToolDef,
} from '../tools/types';

/**
 * MCP 客户端管理（ARCHITECTURE.md §7.6，参照 DSH 的 mcp 包）：
 * - 每个服务器一条长连接，按配置哈希复用；配置变了就断开重连；闲置 10 分钟断开（stdio 子进程随之退出）
 * - 工具名暴露为 mcp__<server>__<tool>；超过 64 字符或含非法字符时截断并加 12 位哈希，内部保留原名映射
 * - 一次列工具要么整组替换、要么保留上次的（不出现半套）
 * - 调用超时 60 秒；isError 视为工具失败（ToolError 回给模型）
 * - stdio 子进程只继承安全的环境变量（SDK getDefaultEnvironment：PATH/HOME 等），再叠加服务器配置里的 env
 */
export type McpServerRow = typeof mcpServers.$inferSelect;

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
const IDLE_MS = 10 * 60 * 1000;
const MAX_INSTRUCTION_CHARS = 8000;
const MAX_TOOLS_PER_SERVER = 128;

interface RawTool {
  name: string;
  exposedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Conn {
  key: string;
  client: Client;
  tools: RawTool[];
  instructions: string;
  lastUsed: number;
}

interface Status {
  state: McpState;
  error: string | null;
  tools: RawTool[];
}

const conns = new Map<string, Conn>();
const connecting = new Map<string, Promise<Conn>>();
const statuses = new Map<string, Status>();

function configKey(row: McpServerRow): string {
  return createHash('sha256')
    .update(JSON.stringify([row.transport, row.command, row.args, row.env, row.url, row.headers]))
    .digest('hex');
}

export function exposedToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`;
  const clean = raw.replace(/[^A-Za-z0-9_-]/gu, '_');
  if (clean === raw && raw.length <= 64) return raw;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${clean.slice(0, 64 - 13)}_${hash}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}超时（${Math.round(ms / 1000)} 秒）`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function makeTransport(row: McpServerRow): Transport {
  if (row.transport === 'stdio') {
    if (!row.command.trim()) throw new Error('没有填写启动命令');
    return new StdioClientTransport({
      command: row.command.trim(),
      args: row.args,
      env: { ...getDefaultEnvironment(), ...row.env },
      stderr: 'ignore',
    });
  }
  let url: URL;
  try {
    url = new URL(row.url);
  } catch {
    throw new Error('服务器地址不是合法的 URL');
  }
  // mcpFetch：每次请求前校验地址 + 建连时校验实际 IP（防 SSRF / DNS rebinding），网络错误译成中文
  const opts = { requestInit: { headers: row.headers }, fetch: mcpFetch };
  return row.transport === 'sse'
    ? new SSEClientTransport(url, opts)
    : new StreamableHTTPClientTransport(url, opts);
}

async function openConn(row: McpServerRow): Promise<Conn> {
  const client = new Client({ name: 'srh-agent', version: '0.1.0' });
  const transport = makeTransport(row);
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, '连接');
    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, '列出工具');
    const tools = listed.tools.slice(0, MAX_TOOLS_PER_SERVER).map((t) => ({
      name: t.name,
      exposedName: exposedToolName(row.name, t.name),
      description: (t.description ?? '').slice(0, 1500),
      inputSchema: normalizeSchema(t.inputSchema as Record<string, unknown> | undefined),
    }));
    const instructions = (client.getInstructions() ?? '').slice(0, MAX_INSTRUCTION_CHARS);
    return { key: configKey(row), client, tools, instructions, lastUsed: Date.now() };
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
}

function normalizeSchema(s: Record<string, unknown> | undefined): Record<string, unknown> {
  const schema = { ...(s ?? {}) };
  delete schema.$schema;
  if (schema.type !== 'object') return { type: 'object', properties: {} };
  if (!schema.properties) schema.properties = {};
  return schema;
}

/** 取连接（复用 / 配置变化时重连）；失败抛错并记进状态 */
export async function getConn(row: McpServerRow): Promise<Conn> {
  const key = configKey(row);
  const existing = conns.get(row.id);
  if (existing && existing.key === key) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (existing) await closeServer(row.id);
  const inflight = connecting.get(row.id);
  if (inflight) return inflight;
  const prev = statuses.get(row.id);
  statuses.set(row.id, { state: 'connecting', error: null, tools: prev?.tools ?? [] });
  const p = openConn(row)
    .then((conn) => {
      conns.set(row.id, conn);
      statuses.set(row.id, { state: 'ready', error: null, tools: conn.tools });
      conn.client.onclose = () => {
        if (conns.get(row.id) === conn) {
          conns.delete(row.id);
          const s = statuses.get(row.id);
          if (s?.state === 'ready') statuses.set(row.id, { ...s, state: 'idle' });
        }
      };
      return conn;
    })
    .catch((err: unknown) => {
      // 失败时保留上次成功的工具列表（整组保留，不出现半套）
      statuses.set(row.id, {
        state: 'error',
        error: describeMcpError(err).slice(0, 500),
        tools: prev?.tools ?? [],
      });
      throw err;
    })
    .finally(() => connecting.delete(row.id));
  connecting.set(row.id, p);
  return p;
}

export async function closeServer(id: string) {
  const c = conns.get(id);
  conns.delete(id);
  if (c) await c.client.close().catch(() => undefined);
}

export function forgetServer(id: string) {
  statuses.delete(id);
  void closeServer(id);
}

export async function closeAllMcp() {
  await Promise.all([...conns.keys()].map((id) => closeServer(id)));
}

export function closeIdleMcp(maxIdleMs = IDLE_MS) {
  const now = Date.now();
  for (const [id, c] of conns) if (now - c.lastUsed > maxIdleMs) void closeServer(id);
}

/** 给 DTO 用的状态（不触发连接） */
export function serverStatus(row: McpServerRow): {
  state: McpState;
  error: string | null;
  tools: McpToolInfo[];
} {
  const s = statuses.get(row.id);
  const disabled = new Set(row.disabledTools);
  const state: McpState = !row.enabled ? 'disabled' : (s?.state ?? 'idle');
  return {
    state,
    error: s?.error ?? null,
    tools: (s?.tools ?? []).map((t) => ({
      name: t.name,
      exposedName: t.exposedName,
      description: t.description,
      enabled: !disabled.has(t.name),
    })),
  };
}

/** 重新连接并列工具（设置页「刷新」/ 保存后） */
export async function refreshServer(row: McpServerRow): Promise<void> {
  await closeServer(row.id);
  if (!row.enabled) return;
  await getConn(row).catch(() => undefined);
}

function renderContent(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = [];
  for (const item of (result.content as Array<Record<string, unknown>> | undefined) ?? []) {
    if (item.type === 'text') parts.push(String(item.text ?? ''));
    else if (item.type === 'resource') {
      const r = item.resource as { uri?: string; text?: string } | undefined;
      parts.push(r?.text ? `[资源 ${r.uri ?? ''}]\n${r.text}` : `[资源 ${r?.uri ?? ''}]`);
    } else if (item.type === 'resource_link') parts.push(`[资源链接 ${String(item.uri ?? '')}]`);
    else parts.push(`[${String(item.type)} 内容，已省略]`);
  }
  if (!parts.length && result.structuredContent !== undefined)
    parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n') || '（工具没有返回内容）';
}

export async function callMcpTool(
  row: McpServerRow,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  let conn: Conn;
  let result: unknown;
  try {
    conn = await getConn(row);
    result = await withTimeout(
      conn.client.callTool({ name: toolName, arguments: args }, undefined, {
        signal,
        timeout: CALL_TIMEOUT_MS,
      }),
      CALL_TIMEOUT_MS + 1000,
      '工具调用',
    );
  } catch (err) {
    if (err instanceof ToolError || signal?.aborted) throw err;
    throw new ToolError(`MCP 服务器「${row.name}」调用失败：${describeMcpError(err)}`);
  }
  conn.lastUsed = Date.now();
  const text = renderContent(result as { content?: unknown });
  if ((result as { isError?: boolean }).isError)
    throw new ToolError(`MCP 工具返回错误：${text.slice(0, 2000)}`);
  return text;
}

/** 这个会话能用的 MCP 服务器：项目作用域按角色；个人作用域只在主人自己的个人会话里 */
export async function serversForSession(
  ctx: AppContext,
  session: SessionRow,
  thread: ThreadRow | null,
): Promise<McpServerRow[]> {
  const rows = await ctx.db.db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.projectId, session.projectId), eq(mcpServers.enabled, true)));
  return rows.filter((r) => {
    if (r.transport === 'stdio' && !ctx.config.MCP_ALLOW_STDIO) return false;
    if (r.scope === 'personal') {
      return (
        session.role === 'personal' &&
        thread?.kind === 'personal' &&
        thread.ownerUserId === r.ownerUserId
      );
    }
    return (r.roles.length ? r.roles : ['coordinator', 'thread', 'personal']).includes(
      session.role,
    );
  });
}

export interface SessionMcp {
  tools: ToolDef[];
  /** 拼进 system prompt 的服务器说明 */
  instructions: string[];
  /** 连不上的服务器（告诉模型，免得它以为工具不存在是 bug） */
  failures: { name: string; error: string }[];
}

const AnyArgs = z.record(z.string(), z.unknown());

/** 本轮要给模型的 MCP 工具（并发连接各服务器，单个失败不影响其他） */
export async function mcpForSession(
  ctx: AppContext,
  session: SessionRow,
  thread: ThreadRow | null,
): Promise<SessionMcp> {
  const servers = await serversForSession(ctx, session, thread);
  const out: SessionMcp = { tools: [], instructions: [], failures: [] };
  const results = await Promise.all(
    servers.map(async (row) => {
      try {
        return { row, conn: await getConn(row) };
      } catch (err) {
        return { row, error: describeMcpError(err) };
      }
    }),
  );
  for (const r of results) {
    if (!('conn' in r) || !r.conn) {
      out.failures.push({ name: r.row.name, error: r.error ?? '连接失败' });
      continue;
    }
    const { row, conn } = r;
    if (conn.instructions.trim())
      out.instructions.push(`### MCP server: ${row.name}\n${conn.instructions.trim()}`);
    const disabled = new Set(row.disabledTools);
    for (const t of conn.tools) {
      if (disabled.has(t.name)) continue;
      out.tools.push(
        defineTool({
          name: t.exposedName,
          description: `[MCP ${row.name}] ${t.description}`.slice(0, 1600),
          roles: ['coordinator', 'thread', 'personal'],
          schema: AnyArgs,
          jsonSchema: t.inputSchema,
          run: async (tc, args) => {
            await tc.setActivity(`正在调用 ${row.name} 的 ${t.name}`);
            return callMcpTool(row, t.name, args as Record<string, unknown>);
          },
        }),
      );
    }
  }
  return out;
}
