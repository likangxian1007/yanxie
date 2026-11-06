import { and, eq } from 'drizzle-orm';
import {
  ApiError,
  CommandRunInput,
  McpServerCreateInput,
  McpServerUpdateInput,
  ProfileCreateInput,
  ProfileUpdateInput,
  ProviderCreateInput,
  ProviderUpdateInput,
  SessionSettingsInput,
  SkillCreateInput,
  SkillImportInput,
  SkillUpdateInput,
  SlashCommandCreateInput,
  SlashCommandUpdateInput,
  type CommandRunResult,
  type HarnessSummary,
} from '@srh/shared';
import { modelCatalog, resolveModel } from '../../agents/llm/registry';
import { runtimeHooks } from '../../agents/runtime/hooks';
import { agentSessions } from '../../db/schema';
import { parse } from '../../lib/http';
import { requireProject, type ProjectAccess } from '../auth/guard';
import { getSession, toAgentSession, updateSession } from '../agents/service';
import { getThreadRow, threadVisibleTo } from '../threads/service';
import type { ModuleDef } from '../types';
import { listCommands, listProfiles, listSkills } from './catalog';
import * as svc from './service';

/**
 * Agent harness 能力（API.md §2.13，ARCHITECTURE.md §7.6）：模型与推理强度、MCP 服务器、Skill、
 * 斜杠指令、科研 profile。归属：harness 线程。
 *
 *   GET    P/harness                         输入框一次取齐：模型目录 + 指令 + skill + profile
 *   GET    P/models                          模型目录
 *   POST   P/providers  PATCH/DELETE P/providers/:id  POST P/providers/:id/test
 *   GET    P/mcp-servers  POST  PATCH/DELETE P/mcp-servers/:id  POST P/mcp-servers/:id/refresh
 *   GET    P/skills  POST  POST P/skills/import  PATCH/DELETE P/skills/:id
 *   GET    P/commands  POST  PATCH/DELETE P/commands/:id  POST P/commands/run
 *   GET    P/profiles  POST  PATCH/DELETE P/profiles/:id
 *   PATCH  P/agents/:sessionId/settings      会话的模型 / 强度 / profile
 */
type P = { projectId: string };
type PI = P & { id: string };
type PS = P & { sessionId: string };

/** 个人作用域只在个人工作区里有意义；设置页 / 输入框都按「我」来看 */
function me(access: ProjectAccess) {
  return access.user.id;
}

export const harnessModule: ModuleDef = {
  name: 'harness',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;
    const base = '/projects/:projectId';

    app.get<{ Params: P }>(`${base}/harness`, async (req): Promise<HarnessSummary> => {
      const access = await requireProject(req, req.params.projectId, 'view');
      const pid = req.params.projectId;
      const [catalog, commands, skills, profiles] = await Promise.all([
        modelCatalog(ctx, pid),
        listCommands(ctx, pid, me(access)),
        listSkills(ctx, pid, me(access)),
        listProfiles(ctx, pid, me(access)),
      ]);
      return { catalog, commands, skills, profiles };
    });

    app.get<{ Params: P }>(`${base}/models`, async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return modelCatalog(ctx, req.params.projectId);
    });

    // ------------------------------------------------------------ provider
    app.post<{ Params: P }>(`${base}/providers`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'manage');
      return reply
        .status(201)
        .send(
          await svc.createProvider(
            ctx,
            access,
            req.params.projectId,
            parse(ProviderCreateInput, req.body),
          ),
        );
    });
    app.patch<{ Params: PI }>(`${base}/providers/:id`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'manage');
      return svc.updateProvider(
        ctx,
        access,
        req.params.projectId,
        req.params.id,
        parse(ProviderUpdateInput, req.body),
      );
    });
    app.delete<{ Params: PI }>(`${base}/providers/:id`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'manage');
      await svc.deleteProvider(ctx, access, req.params.projectId, req.params.id);
      return reply.status(204).send();
    });
    app.post<{ Params: PI }>(`${base}/providers/:id/test`, async (req) => {
      await requireProject(req, req.params.projectId, 'manage');
      return svc.testProvider(ctx, req.params.projectId, req.params.id);
    });

    // ------------------------------------------------------------ MCP
    app.get<{ Params: P }>(`${base}/mcp-servers`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'view');
      return svc.listMcpServers(ctx, access, req.params.projectId);
    });
    app.post<{ Params: P }>(`${base}/mcp-servers`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      return reply
        .status(201)
        .send(
          await svc.createMcpServer(
            ctx,
            access,
            req.params.projectId,
            parse(McpServerCreateInput, req.body),
          ),
        );
    });
    app.patch<{ Params: PI }>(`${base}/mcp-servers/:id`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      return svc.updateMcpServer(
        ctx,
        access,
        req.params.projectId,
        req.params.id,
        parse(McpServerUpdateInput, req.body),
      );
    });
    app.delete<{ Params: PI }>(`${base}/mcp-servers/:id`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      await svc.deleteMcpServer(ctx, access, req.params.projectId, req.params.id);
      return reply.status(204).send();
    });
    app.post<{ Params: PI }>(`${base}/mcp-servers/:id/refresh`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      return svc.refreshMcpServer(ctx, access, req.params.projectId, req.params.id);
    });

    // ------------------------------------------------------------ skill
    app.get<{ Params: P }>(`${base}/skills`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'view');
      return listSkills(ctx, req.params.projectId, me(access), false);
    });
    app.post<{ Params: P }>(`${base}/skills`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      return reply
        .status(201)
        .send(
          await svc.createSkill(
            ctx,
            access,
            req.params.projectId,
            parse(SkillCreateInput, req.body),
          ),
        );
    });
    app.post<{ Params: P }>(`${base}/skills/import`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      return reply
        .status(201)
        .send(
          await svc.importSkill(
            ctx,
            access,
            req.params.projectId,
            parse(SkillImportInput, req.body),
          ),
        );
    });
    app.patch<{ Params: PI }>(`${base}/skills/:id`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      return svc.updateSkill(
        ctx,
        access,
        req.params.projectId,
        req.params.id,
        parse(SkillUpdateInput, req.body),
      );
    });
    app.delete<{ Params: PI }>(`${base}/skills/:id`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      await svc.deleteSkill(ctx, access, req.params.projectId, req.params.id);
      return reply.status(204).send();
    });

    // ------------------------------------------------------------ 指令
    app.get<{ Params: P }>(`${base}/commands`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'view');
      return listCommands(ctx, req.params.projectId, me(access));
    });
    app.post<{ Params: P }>(`${base}/commands`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      return reply
        .status(201)
        .send(
          await svc.createCommand(
            ctx,
            access,
            req.params.projectId,
            parse(SlashCommandCreateInput, req.body),
          ),
        );
    });
    app.patch<{ Params: PI }>(`${base}/commands/:id`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      return svc.updateCommand(
        ctx,
        access,
        req.params.projectId,
        req.params.id,
        parse(SlashCommandUpdateInput, req.body),
      );
    });
    app.delete<{ Params: PI }>(`${base}/commands/:id`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      await svc.deleteCommand(ctx, access, req.params.projectId, req.params.id);
      return reply.status(204).send();
    });

    /** 会话类指令：/clear、/compact、/goal clear */
    app.post<{ Params: P }>(`${base}/commands/run`, async (req): Promise<CommandRunResult> => {
      const access = await requireProject(req, req.params.projectId, 'write');
      const input = parse(CommandRunInput, req.body);
      const session = await sessionFor(access, req.params.projectId, input.threadId);
      const name = input.name.replace(/^\//u, '');
      if (name === 'clear') {
        if (session.status === 'running')
          return { ok: false, text: 'agent 正在工作，先停止再清空上下文', messageId: null };
        const had = await svc.clearSessionContext(ctx, session.id);
        return {
          ok: true,
          text: had ? '已清空 agent 的对话上下文，消息记录仍然保留' : '上下文本来就是空的',
          messageId: null,
        };
      }
      if (name === 'compact') {
        if (session.status === 'running')
          return { ok: false, text: 'agent 正在工作，等这一轮结束再压缩', messageId: null };
        if (!runtimeHooks.compactSession)
          return { ok: false, text: '模型服务没有启动，暂时不能压缩', messageId: null };
        const done = await runtimeHooks.compactSession(session.id);
        return {
          ok: true,
          text: done ? '已把较早的对话压缩成摘要' : '对话还很短，不需要压缩',
          messageId: null,
        };
      }
      if (name === 'goal' && input.args.trim() === 'clear') {
        await updateSession(ctx, session.id, { goal: null }, access.actor);
        return { ok: true, text: '已清除持续目标', messageId: null };
      }
      throw new ApiError('bad_request', `/${name} 不是会话类指令，直接作为消息发送即可`);
    });

    // ------------------------------------------------------------ profile
    app.get<{ Params: P }>(`${base}/profiles`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'view');
      return listProfiles(ctx, req.params.projectId, me(access), false);
    });
    app.post<{ Params: P }>(`${base}/profiles`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      return reply
        .status(201)
        .send(
          await svc.createProfile(
            ctx,
            access,
            req.params.projectId,
            parse(ProfileCreateInput, req.body),
          ),
        );
    });
    app.patch<{ Params: PI }>(`${base}/profiles/:id`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      return svc.updateProfile(
        ctx,
        access,
        req.params.projectId,
        req.params.id,
        parse(ProfileUpdateInput, req.body),
      );
    });
    app.delete<{ Params: PI }>(`${base}/profiles/:id`, async (req, reply) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      await svc.deleteProfile(ctx, access, req.params.projectId, req.params.id);
      return reply.status(204).send();
    });

    // ------------------------------------------------------------ 会话设置
    app.patch<{ Params: PS }>(`${base}/agents/:sessionId/settings`, async (req) => {
      const access = await requireProject(req, req.params.projectId, 'write');
      const input = parse(SessionSettingsInput, req.body);
      const row = await getSession(ctx, req.params.projectId, req.params.sessionId);
      if (!row) throw new ApiError('not_found', 'agent 会话不存在');
      await assertSessionVisible(access, row.threadId);
      const set: Partial<typeof row> = {};
      if (input.model !== undefined) {
        // 校验模型存在；null 回到项目默认
        if (input.model) {
          const r = await resolveModel(ctx, row.projectId, input.model, null);
          if (r.id !== input.model)
            throw new ApiError('validation_failed', `没有这个模型：${input.model}`, {
              issues: [{ path: 'model', message: '模型不存在或已停用' }],
            });
        }
        set.model = input.model ?? (await modelCatalog(ctx, row.projectId)).defaultModel;
      }
      if (input.effort !== undefined) set.effort = input.effort;
      if (input.profile !== undefined) {
        if (input.profile) {
          const owner = await personalOwner(row.projectId, row.threadId);
          const profiles = await listProfiles(ctx, row.projectId, owner);
          if (!profiles.some((p) => p.slug === input.profile))
            throw new ApiError('validation_failed', `没有这个 profile：${input.profile}`);
        }
        set.profile = input.profile;
      }
      const updated = Object.keys(set).length
        ? await updateSession(ctx, row.id, set, access.actor)
        : row;
      return toAgentSession(updated ?? row);
    });

    async function personalOwner(projectId: string, threadId: string | null) {
      if (!threadId) return null;
      const t = await getThreadRow(ctx, projectId, threadId).catch(() => null);
      return t?.kind === 'personal' ? t.ownerUserId : null;
    }

    async function assertSessionVisible(access: ProjectAccess, threadId: string | null) {
      if (!threadId) return;
      const t = await getThreadRow(ctx, access.project.id, threadId);
      if (!t || !threadVisibleTo(t, access.user.id))
        throw new ApiError('not_found', 'agent 会话不存在');
    }

    async function sessionFor(access: ProjectAccess, projectId: string, threadId: string | null) {
      const [row] = await ctx.db.db
        .select()
        .from(agentSessions)
        .where(
          threadId
            ? and(eq(agentSessions.projectId, projectId), eq(agentSessions.threadId, threadId))
            : and(eq(agentSessions.projectId, projectId), eq(agentSessions.role, 'coordinator')),
        );
      if (!row) throw new ApiError('not_found', '这里还没有 agent 会话');
      await assertSessionVisible(access, row.threadId);
      return row;
    }
  },
};
