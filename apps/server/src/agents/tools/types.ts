import { z } from 'zod';
import type { ActorRef, AgentRole } from '@srh/shared';
import type { AppContext } from '../../context';
import type { agentSessions, projects, threads } from '../../db/schema';
import type { ChatToolSpec } from '../llm/complete';

/**
 * agent 工具的定义方式。每个工具 = zod 入参 + 可用角色 + 实现。
 * 入参名用 snake_case（与 prompts/ 一致），工具结果是给模型看的 JSON（尽量精简）。
 */
export type SessionRow = typeof agentSessions.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;

export interface ToolContext {
  ctx: AppContext;
  session: SessionRow;
  project: ProjectRow;
  /** 线程 / 个人会话的线程；协调者为 null */
  thread: ThreadRow | null;
  turnId: string;
  /** 这个 agent 作为作者时的身份：{ kind:'agent', id: sessionId, name: '研协' } */
  actor: ActorRef & { id: string };
  /** 本轮触发消息的作者（用于 working_for 默认值等） */
  requesterUserId: string | null;
  /** 本轮已调用过的对外可见工具（turn 结束判定用） */
  visible: Set<string>;
  /** 工具改了 activity（一句话动态）时调用，运行时会推 agent.updated */
  setActivity: (text: string | null) => Promise<void>;
}

/** 工具执行失败时抛这个（或 ApiError），运行时把 message 当作工具结果返回给模型，不中断 turn */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  roles: readonly AgentRole[];
  schema: S;
  /** 调用后算作对外可见的结束动作（reply / post_message / update_status / react / …） */
  visible?: boolean;
  /** 仅在条件满足时出现在工具列表（协作端口已注册、联网已开启…） */
  enabled?: (ctx: AppContext) => boolean;
  /** 直接给模型的 JSON Schema（MCP 工具自带 inputSchema，不经 zod 转换；schema 只做宽松校验） */
  jsonSchema?: Record<string, unknown>;
  run: (tc: ToolContext, args: z.infer<S>) => Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export function toolSpec(def: ToolDef): ChatToolSpec {
  if (def.jsonSchema)
    return { name: def.name, description: def.description, parameters: def.jsonSchema };
  const schema = z.toJSONSchema(def.schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return { name: def.name, description: def.description, parameters: objectParameters(schema) };
}

/**
 * 模型接口要求函数参数顶层为 object，不能直接发送 Zod 联合产生的 anyOf / oneOf。
 * 只展开由对象组成的顶层联合，按字段保留各分支的类型；条件必填等关联约束仍由
 * def.schema 在实际执行前校验。参数名与调用格式不变，也不执行任何分支的默认值转换。
 */
function objectParameters(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type !== undefined) return schema;
  const branches = schema.anyOf ?? schema.oneOf;
  if (
    !Array.isArray(branches) ||
    !branches.length ||
    !branches.every((branch) => branch?.type === 'object' && branch.properties)
  )
    return schema;

  const fields = new Map<string, unknown[]>();
  for (const branch of branches) {
    for (const [key, value] of Object.entries(branch.properties)) {
      const variants = fields.get(key) ?? [];
      if (!variants.some((variant) => JSON.stringify(variant) === JSON.stringify(value)))
        variants.push(value);
      fields.set(key, variants);
    }
  }
  const required = ((branches[0].required ?? []) as string[]).filter((key) =>
    branches.every((branch) => branch.required?.includes(key)),
  );
  const result: Record<string, unknown> = {
    ...schema,
    type: 'object',
    properties: Object.fromEntries(
      [...fields].map(([key, variants]) => [
        key,
        variants.length === 1 ? variants[0] : { anyOf: variants },
      ]),
    ),
    required,
  };
  delete result.anyOf;
  delete result.oneOf;
  return result;
}

export const ALL_ROLES = ['coordinator', 'thread', 'personal'] as const;
export const WORKER_ROLES = ['thread', 'personal'] as const;
