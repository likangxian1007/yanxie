import {
  EFFORT_LABEL,
  type AgentProfile,
  type AgentSession,
  type ModelCatalog,
  type ModelInfo,
  type ReasoningEffort,
} from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * 模型目录的纯函数：会话里存的是模型 id `<providerId>/<model>`；老会话可能只存了裸模型名
 *（如 deepseek-chat），在目录里找不到时显示项目默认模型。
 */

export const EFFORT_ORDER: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max'];

export function isEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (EFFORT_ORDER as string[]).includes(v);
}

/** 目录里所有可选模型（停用的 provider 不算），按 provider 顺序。 */
export function allModels(catalog: ModelCatalog | undefined): ModelInfo[] {
  if (!catalog) return [];
  return catalog.providers.filter((p) => p.enabled).flatMap((p) => p.models);
}

/** 按 id 找模型；找不到时按裸模型名兼容老会话。 */
export function findModel(
  catalog: ModelCatalog | undefined,
  id: string | null | undefined,
): ModelInfo | null {
  if (!catalog || !id) return null;
  const models = allModels(catalog);
  return models.find((m) => m.id === id) ?? models.find((m) => m.model === id) ?? null;
}

/** 会话实际在用的模型：会话的 → 项目默认 → 目录第一个。 */
export function sessionModel(
  catalog: ModelCatalog | undefined,
  modelId: string | null | undefined,
): ModelInfo | null {
  if (!catalog) return null;
  return (
    findModel(catalog, modelId) ??
    findModel(catalog, catalog.defaultModel) ??
    allModels(catalog)[0] ??
    null
  );
}

/** 按服务端的档位兼容规则显示实际强度。 */
export function effectiveEffort(
  model: ModelInfo | null,
  sessionEffort: string | null | undefined,
): ReasoningEffort | null {
  if (!model) return isEffort(sessionEffort) ? sessionEffort : null;
  if (isEffort(sessionEffort) && model.efforts.includes(sessionEffort)) return sessionEffort;
  if (isEffort(sessionEffort) && sessionEffort !== 'off') {
    const fallback = (['high', 'medium', 'low'] as const).find((e) => model.efforts.includes(e));
    if (fallback) return fallback;
  }
  return model.defaultEffort;
}

/** 有多档强度的模型才显示强度。 */
export function hasEffortChoice(model: ModelInfo | null): boolean {
  return Boolean(model && model.efforts.length > 1);
}

/** 工具栏上的一行：DeepSeek V4 Pro · 高 */
export function modelLabel(model: ModelInfo | null, effort: ReasoningEffort | null): string {
  if (!model) return tr('默认模型');
  if (!effort || !hasEffortChoice(model)) return model.name;
  return `${model.name} · ${EFFORT_LABEL[effort]}`;
}

/**
 * 手机上用的短名：去掉打头的厂商词（DeepSeek V4.1 Flash → V4.1 Flash），完整名放 tooltip。
 * 只有两个词以内的名字原样返回，避免把型号本身删掉。
 */
export function shortModelLabel(model: ModelInfo | null, effort: ReasoningEffort | null): string {
  if (!model) return tr('默认模型');
  const words = model.name.trim().split(/\s+/u);
  const name = words.length >= 3 ? words.slice(1).join(' ') : model.name;
  if (!effort || !hasEffortChoice(model)) return name;
  return `${name} · ${EFFORT_LABEL[effort]}`;
}
export interface SessionModelView {
  model: ModelInfo | null;
  effort: ReasoningEffort | null;
  profile: AgentProfile | null;
}

export function sessionView(
  catalog: ModelCatalog | undefined,
  profiles: AgentProfile[] | undefined,
  session: Pick<AgentSession, 'model' | 'effort' | 'profile'> | null,
): SessionModelView {
  const model = sessionModel(catalog, session?.model);
  const profile = findProfile(profiles, session?.profile);
  return {
    model,
    effort: effectiveEffort(model, session?.effort ?? profile?.effort ?? catalog?.defaultEffort),
    profile,
  };
}

export function findProfile(
  profiles: AgentProfile[] | undefined,
  slug: string | null | undefined,
): AgentProfile | null {
  if (!profiles || !slug) return null;
  return profiles.find((p) => p.slug === slug) ?? null;
}

/**
 * 换模型时强度怎么办：当前强度新模型也支持就保留（返回 undefined = 不改），
 * 否则回到模型默认（返回 null）。
 */
export function effortForModelChange(
  next: ModelInfo,
  currentSessionEffort: string | null | undefined,
): null | undefined {
  if (!isEffort(currentSessionEffort)) return undefined;
  return next.efforts.includes(currentSessionEffort) ? undefined : null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** /model <参数>：按 id、模型名、显示名精确匹配，其次唯一的包含匹配。 */
export function matchModel(catalog: ModelCatalog | undefined, arg: string): ModelInfo | null {
  const q = norm(arg);
  if (!q) return null;
  const models = allModels(catalog);
  const exact = models.find((m) => norm(m.id) === q || norm(m.model) === q || norm(m.name) === q);
  if (exact) return exact;
  const partial = models.filter(
    (m) => norm(m.id).includes(q) || norm(m.name).includes(q) || norm(m.model).includes(q),
  );
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

/** /effort <参数>：英文档位或中文名（高、最高、不思考…）。 */
export function matchEffort(arg: string): ReasoningEffort | null {
  const q = norm(arg);
  if (isEffort(q)) return q;
  const hit = EFFORT_ORDER.find((e) => EFFORT_LABEL[e] === arg.trim());
  return hit ?? null;
}

const NO_PROFILE = new Set(['none', 'off', 'clear', tr('无'), tr('不用'), tr('通用')]);

/** /profile <参数>：slug 或名字；none / 无 表示不用 profile（返回 null）；匹配不到返回 undefined。 */
export function matchProfile(
  profiles: AgentProfile[] | undefined,
  arg: string,
): AgentProfile | null | undefined {
  const q = norm(arg);
  if (NO_PROFILE.has(q)) return null;
  const list = profiles ?? [];
  return list.find((p) => norm(p.slug) === q || norm(p.name) === q) ?? undefined;
}

/**
 * 按 provider 分组（模型选择器用）。带 `group` 标记的模型（如 OpenRouter）再拆成
 * 「国内」「国外」两组，组名为「<provider> · 国内」。
 */
export function groupModels(
  catalog: ModelCatalog | undefined,
): { id: string; name: string; models: ModelInfo[] }[] {
  if (!catalog) return [];
  return catalog.providers
    .filter((p) => p.enabled && p.models.length > 0)
    .flatMap((p) => {
      if (!p.models.some((m) => m.group)) return [{ id: p.id, name: p.name, models: p.models }];
      const cn = p.models.filter((m) => m.group === 'cn');
      const intl = p.models.filter((m) => m.group === 'intl');
      const other = p.models.filter((m) => !m.group);
      return [
        { id: `${p.id}:cn`, name: tr('{name} · 国内', { name: p.name }), models: cn },
        { id: `${p.id}:intl`, name: tr('{name} · 国外', { name: p.name }), models: intl },
        { id: p.id, name: p.name, models: other },
      ].filter((g) => g.models.length > 0);
    });
}
