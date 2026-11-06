import { and, asc, eq, or } from 'drizzle-orm';
import type { AgentProfile, HarnessScope, ReasoningEffort, Skill, SlashCommand } from '@srh/shared';
import type { AppContext } from '../../context';
import { agentProfiles, skills, slashCommands } from '../../db/schema';
import profileSeeds from './profiles.seed.json';
import skillSeeds from './skills.seed.json';

/**
 * harness 目录：内置（随代码发布）+ 项目 + 个人，按 slug 合并。
 * 优先级 personal > project > builtin（同 slug 的高优先级条目覆盖低优先级，「复制到项目」后编辑即可改内置内容）。
 * 内置科研 profile / skill 的调研依据见 docs/research-ai-landscape.md。
 */
export type SkillRow = typeof skills.$inferSelect;
export type CommandRow = typeof slashCommands.$inferSelect;
export type ProfileRow = typeof agentProfiles.$inferSelect;

interface SkillSeed {
  slug: string;
  name: string;
  description: string;
  body: string;
}
interface ProfileSeed {
  slug: string;
  name: string;
  description: string;
  icon: string;
  prompt: string;
  skills: string[];
  starters: string[];
  effort: ReasoningEffort | null;
}

const RANK: Record<HarnessScope, number> = { builtin: 0, project: 1, personal: 2 };

export const BUILTIN_SKILLS: Skill[] = (skillSeeds as SkillSeed[]).map((s) => ({
  id: `builtin:${s.slug}`,
  projectId: null,
  scope: 'builtin',
  ownerUserId: null,
  slug: s.slug,
  name: s.name,
  description: s.description,
  body: s.body,
  attachments: [],
  enabled: true,
  userInvocable: true,
  modelInvocable: true,
  updatedBy: null,
  updatedAt: null,
}));

export const BUILTIN_PROFILES: AgentProfile[] = (profileSeeds as ProfileSeed[]).map((p) => ({
  id: `builtin:${p.slug}`,
  projectId: null,
  scope: 'builtin',
  ownerUserId: null,
  slug: p.slug,
  name: p.name,
  description: p.description,
  icon: p.icon,
  prompt: p.prompt,
  skills: p.skills,
  starters: p.starters,
  effort: p.effort ?? null,
  updatedAt: null,
}));

function builtin(
  name: string,
  kind: SlashCommand['kind'],
  description: string,
  argumentHint = '',
): SlashCommand {
  return {
    id: `builtin:${name}`,
    projectId: null,
    scope: 'builtin',
    ownerUserId: null,
    name,
    description,
    argumentHint,
    kind,
    template: '',
    updatedAt: null,
  };
}

/** 内置斜杠指令（顺序即菜单顺序）；kind 的含义见 packages/shared/src/harness.ts CommandKind */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  builtin(
    'goal',
    'prompt',
    '设定持续目标：agent 会一直推进直到完成或需要你决定；/goal clear 清除',
    '<目标>',
  ),
  builtin('plan', 'prompt', '先出计划再动手：列出步骤、依赖与风险，等你确认后执行', '<任务>'),
  builtin('skill', 'prompt', '让 agent 按某个 skill 的流程做事', '<skill> [补充说明]'),
  builtin('model', 'client', '切换这个会话的模型', '[模型]'),
  builtin('effort', 'client', '切换推理强度：off / low / high / max', '[强度]'),
  builtin('profile', 'client', '换一个科研 profile（角色与默认 skill）', '[profile]'),
  builtin('clear', 'session', '清空 agent 的对话上下文（消息记录保留，记忆与文件不受影响）'),
  builtin('compact', 'session', '把较早的对话压缩成摘要，腾出上下文'),
  builtin('forward', 'client', '把这个个人会话转给协调者'),
  builtin('stop', 'client', '停止 agent 当前这一轮'),
  builtin('help', 'client', '查看全部指令与 skill'),
];

export function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    projectId: row.projectId,
    scope: row.scope,
    ownerUserId: row.ownerUserId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    body: row.body,
    attachments: row.attachments.map((a) => ({
      path: a.path,
      size: Buffer.byteLength(a.content, 'utf8'),
    })),
    enabled: row.enabled,
    userInvocable: row.userInvocable,
    modelInvocable: row.modelInvocable,
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCommand(row: CommandRow): SlashCommand {
  return {
    id: row.id,
    projectId: row.projectId,
    scope: row.scope,
    ownerUserId: row.ownerUserId,
    name: row.name,
    description: row.description,
    argumentHint: row.argumentHint,
    kind: 'prompt',
    template: row.template,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProfile(row: ProfileRow): AgentProfile {
  return {
    id: row.id,
    projectId: row.projectId,
    scope: row.scope,
    ownerUserId: row.ownerUserId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    icon: row.icon,
    prompt: row.prompt,
    skills: row.skills,
    starters: row.starters,
    effort: row.effort ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 本人能看到的行：项目作用域 + 自己的个人作用域（userId=null 只看项目作用域） */
function scopeFilter(
  projectIdCol: typeof skills.projectId,
  scopeCol: typeof skills.scope,
  ownerCol: typeof skills.ownerUserId,
  projectId: string,
  userId: string | null,
) {
  return and(
    eq(projectIdCol, projectId),
    userId
      ? or(eq(scopeCol, 'project'), and(eq(scopeCol, 'personal'), eq(ownerCol, userId)))
      : eq(scopeCol, 'project'),
  );
}

function mergeBySlug<T extends { scope: HarnessScope }>(items: T[], key: (t: T) => string): T[] {
  const best = new Map<string, T>();
  for (const it of items) {
    const k = key(it);
    const cur = best.get(k);
    if (!cur || RANK[it.scope] > RANK[cur.scope]) best.set(k, it);
  }
  // 保持原有顺序（内置在前），被覆盖的条目落在覆盖者的位置
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(best.get(k)!);
  }
  return out;
}

/**
 * skill 目录。merged=true 时同 slug 只留生效的那一条（给 agent / 输入框用）；
 * false 时全部列出（设置页要能看到被覆盖的内置条目）。userId=null 只看项目作用域（协调者 / 线程 agent）。
 */
export async function listSkills(
  ctx: AppContext,
  projectId: string,
  userId: string | null,
  merged = true,
): Promise<Skill[]> {
  const rows = await ctx.db.db
    .select()
    .from(skills)
    .where(scopeFilter(skills.projectId, skills.scope, skills.ownerUserId, projectId, userId))
    .orderBy(asc(skills.createdAt));
  const all = [...BUILTIN_SKILLS, ...rows.map(toSkill)];
  return merged ? mergeBySlug(all, (s) => s.slug) : all;
}

export async function listProfiles(
  ctx: AppContext,
  projectId: string,
  userId: string | null,
  merged = true,
): Promise<AgentProfile[]> {
  const rows = await ctx.db.db
    .select()
    .from(agentProfiles)
    .where(
      scopeFilter(
        agentProfiles.projectId as unknown as typeof skills.projectId,
        agentProfiles.scope as unknown as typeof skills.scope,
        agentProfiles.ownerUserId as unknown as typeof skills.ownerUserId,
        projectId,
        userId,
      ),
    )
    .orderBy(asc(agentProfiles.createdAt));
  const all = [...BUILTIN_PROFILES, ...rows.map(toProfile)];
  return merged ? mergeBySlug(all, (p) => p.slug) : all;
}

export async function listCommands(
  ctx: AppContext,
  projectId: string,
  userId: string | null,
): Promise<SlashCommand[]> {
  const rows = await ctx.db.db
    .select()
    .from(slashCommands)
    .where(
      scopeFilter(
        slashCommands.projectId as unknown as typeof skills.projectId,
        slashCommands.scope as unknown as typeof skills.scope,
        slashCommands.ownerUserId as unknown as typeof skills.ownerUserId,
        projectId,
        userId,
      ),
    )
    .orderBy(asc(slashCommands.createdAt));
  const custom = mergeBySlug(rows.map(toCommand), (c) => c.name);
  return [...BUILTIN_COMMANDS, ...custom];
}

/** 原始 skill 行（读附件用）；内置 skill 返回 null */
export async function skillRow(ctx: AppContext, id: string): Promise<SkillRow | null> {
  if (id.startsWith('builtin:')) return null;
  const [row] = await ctx.db.db.select().from(skills).where(eq(skills.id, id));
  return row ?? null;
}
