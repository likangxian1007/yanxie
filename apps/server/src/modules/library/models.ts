import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { ApiError } from '@srh/shared';
import type { AppContext } from '../../context';
import { llmProviders, projectMembers, projects } from '../../db/schema';
import { envProviders, projectProviders, rowToProvider } from '../../agents/llm/registry';
import { libraryScope, type LibraryScopeInput } from './scope';

/** 个人资料不改变归属；只借用当前账号有调用权限的模型，每次请求重新检查成员身份。 */
export async function libraryProviders(ctx: AppContext, input: LibraryScopeInput) {
  const scope = libraryScope(input);
  if (scope.kind === 'project')
    return (await projectProviders(ctx, scope.projectId)).filter(
      (p) => p.enabled && p.models.length,
    );
  const rows = await ctx.db.db
    .select({ provider: llmProviders, projectName: projects.name })
    .from(llmProviders)
    .innerJoin(projectMembers, eq(projectMembers.projectId, llmProviders.projectId))
    .innerJoin(projects, eq(projects.id, llmProviders.projectId))
    .where(
      and(
        eq(projectMembers.userId, scope.ownerUserId),
        inArray(projectMembers.role, ['owner', 'advisor', 'member']),
        isNull(projects.archivedAt),
        eq(llmProviders.enabled, true),
      ),
    )
    .orderBy(asc(llmProviders.createdAt), asc(llmProviders.id));
  return [
    ...envProviders(ctx.config),
    ...rows.map(({ provider, projectName }) => ({
      ...rowToProvider(provider),
      name: `${projectName} · ${provider.name}`,
    })),
  ].filter((p) => p.enabled && p.models.length);
}

export async function libraryDefaultModel(ctx: AppContext, scope: LibraryScopeInput) {
  const providers = await libraryProviders(ctx, scope);
  const entries = providers.flatMap((provider) =>
    provider.models.map((info) => ({
      id: `${provider.id}/${info.model}`,
      provider,
      info,
    })),
  );
  const entry = entries.find((m) => m.id === ctx.config.LLM_DEFAULT_MODEL) ?? entries[0];
  if (!entry)
    throw new ApiError(
      'llm_unavailable',
      '尚无可用模型，请在你有写入权限的项目中打开“设置 → 模型”进行配置',
    );
  return entry;
}
