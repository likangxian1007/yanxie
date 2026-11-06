import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ApiError,
  BUILTIN_COMMAND_NAMES,
  newId,
  type ActorRef,
  type AgentProfile,
  type LlmProvider,
  type McpServer,
  type McpServerCreateInput,
  type McpServerUpdateInput,
  type ProfileCreateInput,
  type ProfileUpdateInput,
  type ProviderCreateInput,
  type ProviderUpdateInput,
  type Skill,
  type SkillCreateInput,
  type SkillImportInput,
  type SkillUpdateInput,
  type SlashCommand,
  type SlashCommandCreateInput,
  type SlashCommandUpdateInput,
  type WritableScope,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  agentProfiles,
  agentSessions,
  agentSteps,
  llmProviders,
  mcpServers,
  skills,
  slashCommands,
} from '../../db/schema';
import {
  clientFor,
  envProviders,
  getProviderRow,
  rowToProvider,
  thinkingParams,
  toProviderDto,
  type ResolvedProvider,
} from '../../agents/llm/registry';
import {
  forgetServer,
  refreshServer,
  serverStatus,
  type McpServerRow,
} from '../../agents/mcp/manager';
import type { ProjectAccess } from '../auth/guard';
import { can } from '../auth/guard';
import { toCommand, toProfile, toSkill } from './catalog';
import { checkMcpUrl, MCP_BLOCKED_MESSAGE, McpNetError } from './mcp-net';

/**
 * harness 模块的写操作（API.md §2.13）。
 * 权限：project 作用域 = 管理（owner / advisor）；personal 作用域 = 任何可写成员，只能改自己的。
 * 事件：只广播 project 作用域的变更（个人作用域别人不该知道），客户端写完自行刷新。
 */

// ---------------------------------------------------------------- 权限与事件

export function assertScopeWrite(
  access: ProjectAccess,
  scope: WritableScope,
  ownerUserId: string | null = null,
) {
  if (scope === 'project') {
    if (!can(access.role, 'manage'))
      throw new ApiError('forbidden', '只有项目负责人或导师可以修改项目级配置');
    return;
  }
  if (!can(access.role, 'write')) throw new ApiError('forbidden', '访客不能添加个人配置');
  if (ownerUserId && ownerUserId !== access.user.id)
    throw new ApiError('not_found', '找不到这一项');
}

function assertVisible(access: ProjectAccess, row: { scope: string; ownerUserId: string | null }) {
  if (row.scope === 'personal' && row.ownerUserId !== access.user.id)
    throw new ApiError('not_found', '找不到这一项');
}

async function publish(
  ctx: AppContext,
  projectId: string,
  scope: string,
  type: Parameters<AppContext['bus']['publish']>[0]['type'],
  payload: unknown,
  actor: ActorRef,
) {
  if (scope !== 'project') return;
  await ctx.bus.publish({ projectId, type, payload: payload as never, actor });
}

function conflict(what: string): never {
  throw new ApiError('conflict', `${what}已存在，换个名字或直接编辑原来那一项`);
}

// ---------------------------------------------------------------- provider

type ProviderCreate = z.infer<typeof ProviderCreateInput>;
type ProviderUpdate = z.infer<typeof ProviderUpdateInput>;

function modelRows(input: ProviderCreate['models']) {
  return input.map((m) => ({
    model: m.model,
    name: m.name || m.model,
    description: m.description || null,
    efforts: m.efforts ?? ['off', 'low', 'medium', 'high'],
    defaultEffort: m.defaultEffort ?? 'high',
  }));
}

export async function createProvider(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  input: ProviderCreate,
): Promise<LlmProvider> {
  assertScopeWrite(access, 'project');
  const [row] = await ctx.db.db
    .insert(llmProviders)
    .values({
      id: newId('llmProvider'),
      projectId,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      thinkingFormat: input.thinkingFormat,
      models: modelRows(input.models),
      enabled: input.enabled,
      createdBy: access.actor,
    })
    .returning();
  const dto = toProviderDto(rowToProvider(row!));
  await publish(ctx, projectId, 'project', 'provider.updated', dto, access.actor);
  return dto;
}

export async function updateProvider(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
  input: ProviderUpdate,
): Promise<LlmProvider> {
  assertScopeWrite(access, 'project');
  if (!(await getProviderRow(ctx, projectId, id)))
    throw new ApiError('not_found', '找不到这个模型服务（.env 里配置的只能改 .env）');
  const [row] = await ctx.db.db
    .update(llmProviders)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
      ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
      ...(input.thinkingFormat !== undefined && { thinkingFormat: input.thinkingFormat }),
      ...(input.models !== undefined && { models: modelRows(input.models) }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      updatedAt: new Date(),
    })
    .where(eq(llmProviders.id, id))
    .returning();
  const dto = toProviderDto(rowToProvider(row!));
  await publish(ctx, projectId, 'project', 'provider.updated', dto, access.actor);
  return dto;
}

export async function deleteProvider(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
) {
  assertScopeWrite(access, 'project');
  if (!(await getProviderRow(ctx, projectId, id)))
    throw new ApiError('not_found', '找不到这个模型服务');
  await ctx.db.db.delete(llmProviders).where(eq(llmProviders.id, id));
  await publish(ctx, projectId, 'project', 'provider.deleted', { id }, access.actor);
}

/** 用最小的请求试一下连通性（不思考、最多 8 个 token） */
export async function testProvider(ctx: AppContext, projectId: string, id: string) {
  let p: ResolvedProvider | undefined = envProviders(ctx.config).find((x) => x.id === id);
  if (!p) {
    const row = await getProviderRow(ctx, projectId, id);
    if (row) p = rowToProvider(row);
  }
  if (!p) throw new ApiError('not_found', '找不到这个模型服务');
  const model = p.models[0];
  if (!model) return { ok: false, message: '还没有配置模型', latencyMs: 0 };
  const started = Date.now();
  try {
    const res = await clientFor(p).chat.completions.create(
      {
        ...thinkingParams(p.thinkingFormat, 'off'),
        model: model.model,
        messages: [{ role: 'user', content: '只回复 OK' }],
        max_tokens: 8,
      } as never,
      { timeout: 20_000, maxRetries: 0 },
    );
    const text =
      (res as { choices?: { message?: { content?: string | null } }[] }).choices?.[0]?.message
        ?.content ?? '';
    return {
      ok: true,
      message: `${model.model} 已响应：${text.slice(0, 40) || '（空）'}`,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return {
      ok: false,
      message: `${e.status ? `HTTP ${e.status}：` : ''}${(e.message ?? '请求失败').slice(0, 300)}`,
      latencyMs: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------- MCP

type McpCreate = z.infer<typeof McpServerCreateInput>;
type McpUpdate = z.infer<typeof McpServerUpdateInput>;

export function toMcpServer(row: McpServerRow): McpServer {
  const st = serverStatus(row);
  return {
    id: row.id,
    projectId: row.projectId,
    scope: row.scope,
    ownerUserId: row.ownerUserId,
    name: row.name,
    description: row.description,
    transport: row.transport,
    command: row.command,
    args: row.args,
    envKeys: Object.keys(row.env),
    url: row.url,
    headerKeys: Object.keys(row.headers),
    enabled: row.enabled,
    disabledTools: row.disabledTools,
    roles: row.scope === 'personal' ? ['personal'] : row.roles,
    state: st.state,
    error: st.error,
    tools: st.tools,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listMcpServers(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
): Promise<McpServer[]> {
  const rows = await ctx.db.db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.projectId, projectId))
    .orderBy(mcpServers.createdAt);
  return rows
    .filter((r) => r.scope === 'project' || r.ownerUserId === access.user.id)
    .map(toMcpServer);
}

export async function getMcpRow(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
) {
  const [row] = await ctx.db.db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.projectId, projectId)));
  if (!row) throw new ApiError('not_found', '找不到这个 MCP 服务器');
  assertVisible(access, row);
  return row;
}

async function assertTransport(
  ctx: AppContext,
  access: ProjectAccess,
  transport: string,
  command: string,
  url: string,
) {
  if (transport === 'stdio') {
    if (!ctx.config.MCP_ALLOW_STDIO)
      throw new ApiError(
        'forbidden',
        '这台服务器没有开启本机 MCP（stdio）。请改用 HTTP / SSE 地址，或由部署者在 .env 设置 MCP_ALLOW_STDIO=true',
      );
    if (!can(access.role, 'manage'))
      throw new ApiError(
        'forbidden',
        '本机 MCP 会在服务器上启动进程，只有项目负责人或导师可以添加',
      );
    if (!command.trim())
      throw new ApiError('validation_failed', '请填写启动命令', {
        issues: [{ path: 'command', message: '必填' }],
      });
  } else {
    try {
      const u = new URL(url);
      if (!/^https?:$/u.test(u.protocol)) throw new Error('bad');
    } catch {
      throw new ApiError('validation_failed', '请填写 http(s) 开头的服务器地址', {
        issues: [{ path: 'url', message: '地址无效' }],
      });
    }
    // 防 SSRF：地址（及其 DNS 解析结果）不能落在回环 / 内网 / 链路本地 / 云元数据段。
    // 建连和每次请求时 mcpFetch 还会再查（DNS rebinding）。
    try {
      await checkMcpUrl(url);
    } catch (err) {
      if (!(err instanceof McpNetError)) throw err;
      if (err.kind === 'blocked')
        throw new ApiError('bad_request', MCP_BLOCKED_MESSAGE, {
          issues: [{ path: 'url', message: '不能是内网或本机地址' }],
        });
      if (err.kind === 'invalid')
        throw new ApiError('validation_failed', err.message, {
          issues: [{ path: 'url', message: '地址无效' }],
        });
      // 域名暂时解析不了：允许保存，连接状态里会显示「找不到这个域名」
    }
  }
}

async function assertMcpNameFree(
  ctx: AppContext,
  projectId: string,
  name: string,
  exceptId?: string,
) {
  const rows = await ctx.db.db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.projectId, projectId), eq(mcpServers.name, name)));
  if (rows.some((r) => r.id !== exceptId)) conflict(`MCP 服务器「${name}」`);
}

export async function createMcpServer(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  input: McpCreate,
): Promise<McpServer> {
  assertScopeWrite(access, input.scope);
  await assertTransport(ctx, access, input.transport, input.command, input.url);
  await assertMcpNameFree(ctx, projectId, input.name);
  const [row] = await ctx.db.db
    .insert(mcpServers)
    .values({
      id: newId('mcpServer'),
      projectId,
      scope: input.scope,
      ownerUserId: input.scope === 'personal' ? access.user.id : null,
      name: input.name,
      description: input.description,
      transport: input.transport,
      command: input.command,
      args: input.args,
      env: input.env,
      url: input.url,
      headers: input.headers,
      enabled: input.enabled,
      disabledTools: [],
      roles:
        input.scope === 'personal'
          ? ['personal']
          : (input.roles ?? ['coordinator', 'thread', 'personal']),
      createdBy: access.actor,
    })
    .returning();
  await refreshServer(row!);
  const dto = toMcpServer(row!);
  await publish(ctx, projectId, row!.scope, 'mcp.updated', dto, access.actor);
  return dto;
}

function mergeSecrets(old: Record<string, string>, next: Record<string, string> | undefined) {
  if (!next) return old;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) out[k] = v === '' ? (old[k] ?? '') : v;
  return out;
}

export async function updateMcpServer(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
  input: McpUpdate,
): Promise<McpServer> {
  const old = await getMcpRow(ctx, access, projectId, id);
  assertScopeWrite(access, old.scope, old.ownerUserId);
  const command = input.command ?? old.command;
  const url = input.url ?? old.url;
  if (
    input.command !== undefined ||
    input.url !== undefined ||
    input.args !== undefined ||
    input.env !== undefined
  ) {
    await assertTransport(ctx, access, old.transport, command, url);
  }
  if (input.name && input.name !== old.name)
    await assertMcpNameFree(ctx, projectId, input.name, id);
  const [row] = await ctx.db.db
    .update(mcpServers)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      command,
      url,
      ...(input.args !== undefined && { args: input.args }),
      env: mergeSecrets(old.env, input.env),
      headers: mergeSecrets(old.headers, input.headers),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.disabledTools !== undefined && { disabledTools: input.disabledTools }),
      ...(input.roles !== undefined && old.scope === 'project' && { roles: input.roles }),
      updatedAt: new Date(),
    })
    .where(eq(mcpServers.id, id))
    .returning();
  // 只改了工具开关 / 角色 / 描述时不必重连
  const reconnect = ['name', 'command', 'args', 'env', 'url', 'headers', 'enabled'].some(
    (k) => k in input,
  );
  if (reconnect) await refreshServer(row!);
  const dto = toMcpServer(row!);
  await publish(ctx, projectId, row!.scope, 'mcp.updated', dto, access.actor);
  return dto;
}

export async function deleteMcpServer(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
) {
  const old = await getMcpRow(ctx, access, projectId, id);
  assertScopeWrite(access, old.scope, old.ownerUserId);
  await ctx.db.db.delete(mcpServers).where(eq(mcpServers.id, id));
  forgetServer(id);
  await publish(ctx, projectId, old.scope, 'mcp.deleted', { id }, access.actor);
}

export async function refreshMcpServer(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
): Promise<McpServer> {
  const row = await getMcpRow(ctx, access, projectId, id);
  await refreshServer(row);
  const dto = toMcpServer(row);
  await publish(ctx, projectId, row.scope, 'mcp.updated', dto, access.actor);
  return dto;
}

// ---------------------------------------------------------------- skill

type SkillCreate = z.infer<typeof SkillCreateInput>;
type SkillUpdate = z.infer<typeof SkillUpdateInput>;
type SkillImport = z.infer<typeof SkillImportInput>;

async function getOwned<T extends { scope: WritableScope; ownerUserId: string | null }>(
  rows: T[],
  access: ProjectAccess,
  what: string,
): Promise<T> {
  const row = rows[0];
  if (!row) throw new ApiError('not_found', `找不到这个${what}`);
  assertVisible(access, row);
  assertScopeWrite(access, row.scope, row.ownerUserId);
  return row;
}

export async function createSkill(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  input: SkillCreate,
): Promise<Skill> {
  assertScopeWrite(access, input.scope);
  const owner = input.scope === 'personal' ? access.user.id : null;
  const dup = await ctx.db.db
    .select({ id: skills.id, ownerUserId: skills.ownerUserId })
    .from(skills)
    .where(
      and(
        eq(skills.projectId, projectId),
        eq(skills.scope, input.scope),
        eq(skills.slug, input.slug),
      ),
    );
  if (dup.some((d) => d.ownerUserId === owner)) conflict(`skill「${input.slug}」`);
  const [row] = await ctx.db.db
    .insert(skills)
    .values({
      id: newId('skill'),
      projectId,
      scope: input.scope,
      ownerUserId: owner,
      slug: input.slug,
      name: input.name,
      description: input.description,
      body: input.body,
      attachments: input.attachments,
      enabled: input.enabled,
      userInvocable: input.userInvocable,
      modelInvocable: input.modelInvocable,
      updatedBy: access.actor,
    })
    .returning();
  const dto = toSkill(row!);
  await publish(ctx, projectId, row!.scope, 'skill.updated', dto, access.actor);
  return dto;
}

export async function updateSkill(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
  input: SkillUpdate,
): Promise<Skill> {
  await getOwned(
    await ctx.db.db
      .select()
      .from(skills)
      .where(and(eq(skills.id, id), eq(skills.projectId, projectId))),
    access,
    ' skill',
  );
  const [row] = await ctx.db.db
    .update(skills)
    .set({ ...input, updatedBy: access.actor, updatedAt: new Date() })
    .where(eq(skills.id, id))
    .returning();
  const dto = toSkill(row!);
  await publish(ctx, projectId, row!.scope, 'skill.updated', dto, access.actor);
  return dto;
}

export async function deleteSkill(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
) {
  const row = await getOwned(
    await ctx.db.db
      .select()
      .from(skills)
      .where(and(eq(skills.id, id), eq(skills.projectId, projectId))),
    access,
    ' skill',
  );
  await ctx.db.db.delete(skills).where(eq(skills.id, id));
  await publish(ctx, projectId, row.scope, 'skill.deleted', { id }, access.actor);
}

/** 解析 SKILL.md 的 YAML frontmatter（只认简单的 key: value，够用且不引入 yaml 依赖） */
export function parseSkillMarkdown(md: string): { meta: Record<string, string>; body: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(md);
  if (!m) return { meta: {}, body: md.trim() };
  const meta: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const line of m[1]!.split(/\r?\n/u)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (kv) {
      lastKey = kv[1]!.toLowerCase();
      meta[lastKey] = kv[2]!.trim().replace(/^(['"])([\s\S]*)\1$/u, '$2');
    } else if (lastKey && /^\s+\S/u.test(line)) {
      // 折行的多行值（description: > / |）
      meta[lastKey] = `${meta[lastKey] ?? ''} ${line.trim()}`.replace(/^[>|]-?\s*/u, '').trim();
    }
  }
  return { meta, body: m[2]!.trim() };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40);
}

export async function importSkill(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  input: SkillImport,
): Promise<Skill> {
  const { meta, body } = parseSkillMarkdown(input.markdown);
  const slug = input.slug ?? slugify(meta.name ?? '');
  if (!slug) {
    throw new ApiError(
      'validation_failed',
      'SKILL.md 里没有英文 name，请填写一个 slug（小写字母、数字、连字符）',
      {
        issues: [{ path: 'slug', message: '必填' }],
      },
    );
  }
  const description = meta.description?.trim();
  if (!description) {
    throw new ApiError(
      'validation_failed',
      'SKILL.md 的 frontmatter 缺少 description（agent 靠它判断什么时候用）',
      {
        issues: [{ path: 'markdown', message: '缺少 description' }],
      },
    );
  }
  const flag = (v: string | undefined) => v?.toLowerCase() === 'true';
  return createSkill(ctx, access, projectId, {
    scope: input.scope,
    slug,
    name: (meta.title ?? meta.name ?? slug).slice(0, 60),
    description: description.slice(0, 500),
    body,
    attachments: input.attachments,
    enabled: true,
    userInvocable: meta['user-invocable'] === undefined ? true : flag(meta['user-invocable']),
    modelInvocable: !flag(meta['disable-model-invocation']),
  });
}

// ---------------------------------------------------------------- 自定义指令

type CommandCreate = z.infer<typeof SlashCommandCreateInput>;
type CommandUpdate = z.infer<typeof SlashCommandUpdateInput>;

export async function createCommand(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  input: CommandCreate,
): Promise<SlashCommand> {
  assertScopeWrite(access, input.scope);
  if ((BUILTIN_COMMAND_NAMES as readonly string[]).includes(input.name))
    conflict(`内置指令 /${input.name} `);
  const owner = input.scope === 'personal' ? access.user.id : null;
  const dup = await ctx.db.db
    .select({ ownerUserId: slashCommands.ownerUserId })
    .from(slashCommands)
    .where(
      and(
        eq(slashCommands.projectId, projectId),
        eq(slashCommands.scope, input.scope),
        eq(slashCommands.name, input.name),
      ),
    );
  if (dup.some((d) => d.ownerUserId === owner)) conflict(`指令 /${input.name} `);
  const [row] = await ctx.db.db
    .insert(slashCommands)
    .values({
      id: newId('slashCommand'),
      projectId,
      scope: input.scope,
      ownerUserId: owner,
      name: input.name,
      description: input.description,
      argumentHint: input.argumentHint,
      template: input.template,
    })
    .returning();
  const dto = toCommand(row!);
  await publish(ctx, projectId, row!.scope, 'command.updated', dto, access.actor);
  return dto;
}

export async function updateCommand(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
  input: CommandUpdate,
) {
  await getOwned(
    await ctx.db.db
      .select()
      .from(slashCommands)
      .where(and(eq(slashCommands.id, id), eq(slashCommands.projectId, projectId))),
    access,
    '指令',
  );
  const [row] = await ctx.db.db
    .update(slashCommands)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(slashCommands.id, id))
    .returning();
  const dto = toCommand(row!);
  await publish(ctx, projectId, row!.scope, 'command.updated', dto, access.actor);
  return dto;
}

export async function deleteCommand(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
) {
  const row = await getOwned(
    await ctx.db.db
      .select()
      .from(slashCommands)
      .where(and(eq(slashCommands.id, id), eq(slashCommands.projectId, projectId))),
    access,
    '指令',
  );
  await ctx.db.db.delete(slashCommands).where(eq(slashCommands.id, id));
  await publish(ctx, projectId, row.scope, 'command.deleted', { id }, access.actor);
}

// ---------------------------------------------------------------- profile

type ProfileCreate = z.infer<typeof ProfileCreateInput>;
type ProfileUpdate = z.infer<typeof ProfileUpdateInput>;

export async function createProfile(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  input: ProfileCreate,
): Promise<AgentProfile> {
  assertScopeWrite(access, input.scope);
  const owner = input.scope === 'personal' ? access.user.id : null;
  const dup = await ctx.db.db
    .select({ ownerUserId: agentProfiles.ownerUserId })
    .from(agentProfiles)
    .where(
      and(
        eq(agentProfiles.projectId, projectId),
        eq(agentProfiles.scope, input.scope),
        eq(agentProfiles.slug, input.slug),
      ),
    );
  if (dup.some((d) => d.ownerUserId === owner)) conflict(`profile「${input.slug}」`);
  const [row] = await ctx.db.db
    .insert(agentProfiles)
    .values({ id: newId('agentProfile'), projectId, ownerUserId: owner, ...input })
    .returning();
  const dto = toProfile(row!);
  await publish(ctx, projectId, row!.scope, 'profile.updated', dto, access.actor);
  return dto;
}

export async function updateProfile(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
  input: ProfileUpdate,
) {
  await getOwned(
    await ctx.db.db
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.id, id), eq(agentProfiles.projectId, projectId))),
    access,
    ' profile',
  );
  const [row] = await ctx.db.db
    .update(agentProfiles)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(agentProfiles.id, id))
    .returning();
  const dto = toProfile(row!);
  await publish(ctx, projectId, row!.scope, 'profile.updated', dto, access.actor);
  return dto;
}

export async function deleteProfile(
  ctx: AppContext,
  access: ProjectAccess,
  projectId: string,
  id: string,
) {
  const row = await getOwned(
    await ctx.db.db
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.id, id), eq(agentProfiles.projectId, projectId))),
    access,
    ' profile',
  );
  await ctx.db.db.delete(agentProfiles).where(eq(agentProfiles.id, id));
  await publish(ctx, projectId, row.scope, 'profile.deleted', { id }, access.actor);
}

// ---------------------------------------------------------------- 会话：清空上下文

/** /clear：之前的对话不再进上下文（消息、步骤记录都保留，可在思路里回看） */
export async function clearSessionContext(ctx: AppContext, sessionId: string): Promise<boolean> {
  const [last] = await ctx.db.db
    .select({ turnId: agentSteps.turnId })
    .from(agentSteps)
    .where(eq(agentSteps.sessionId, sessionId))
    .orderBy(desc(agentSteps.turnId))
    .limit(1);
  await ctx.db.db
    .update(agentSessions)
    .set({ contextSummary: '', summaryThroughTurnId: last?.turnId ?? null })
    .where(eq(agentSessions.id, sessionId));
  return Boolean(last);
}
