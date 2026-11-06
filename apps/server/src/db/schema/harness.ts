/**
 * Agent harness 表：模型 provider、MCP 服务器、Skill、自定义斜杠指令、科研 profile。
 * 归属：harness 线程（apps/server/src/modules/harness 与 apps/server/src/agents/{harness,mcp,llm}）。
 * 作用域见 packages/shared/src/harness.ts：project = 项目共享；personal = 只对 owner_user_id 本人生效。
 */
import { boolean, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type {
  ActorRef,
  AgentRole,
  McpTransport,
  ReasoningEffort,
  SkillAttachment,
  ThinkingFormat,
  WritableScope,
} from '@srh/shared';
import { actor, createdAt, id, jsonObject, textArray, updatedAt } from './_helpers';
import { projects, users } from './core';

export interface ProviderModelRow {
  model: string;
  name: string;
  description: string | null;
  efforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  /** 选择器分组（内置模型才有）：cn 国内 / intl 国外 */
  group?: 'cn' | 'intl';
}

export const llmProviders = pgTable(
  'llm_providers',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    /** 明文存库（同 .env 的信任级别）；接口永不回显 */
    apiKey: text('api_key').notNull().default(''),
    thinkingFormat: text('thinking_format').$type<ThinkingFormat>().notNull().default('openai'),
    models: jsonb('models').$type<ProviderModelRow[]>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('llm_providers_project_idx').on(t.projectId)],
);

export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<WritableScope>().notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    transport: text('transport').$type<McpTransport>().notNull(),
    command: text('command').notNull().default(''),
    args: textArray('args'),
    env: jsonObject<Record<string, string>>('env'),
    url: text('url').notNull().default(''),
    headers: jsonObject<Record<string, string>>('headers'),
    enabled: boolean('enabled').notNull().default(true),
    disabledTools: textArray('disabled_tools'),
    roles: textArray('roles').$type<AgentRole[]>(),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('mcp_servers_project_idx').on(t.projectId)],
);

export const skills = pgTable(
  'skills',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<WritableScope>().notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    body: text('body').notNull().default(''),
    attachments: jsonb('attachments').$type<SkillAttachment[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    userInvocable: boolean('user_invocable').notNull().default(true),
    modelInvocable: boolean('model_invocable').notNull().default(true),
    updatedBy: jsonb('updated_by').$type<ActorRef>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('skills_project_idx').on(t.projectId)],
);

export const slashCommands = pgTable(
  'slash_commands',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<WritableScope>().notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    argumentHint: text('argument_hint').notNull().default(''),
    template: text('template').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('slash_commands_project_idx').on(t.projectId)],
);

export const agentProfiles = pgTable(
  'agent_profiles',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<WritableScope>().notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    icon: text('icon').notNull().default('Sparkles'),
    prompt: text('prompt').notNull().default(''),
    skills: textArray('skills'),
    starters: textArray('starters'),
    effort: text('effort').$type<ReasoningEffort>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('agent_profiles_project_idx').on(t.projectId)],
);
