import { ApiRequestError } from '@/lib/api';
import { tr } from '@/lib/i18n';

export interface SplitErrors<F extends string> {
  /** 能对应到输入框的原因 */
  fields: Partial<Record<F, string>>;
  /** 对应不到输入框的总提示（没有则为 null） */
  form: string | null;
}

/**
 * 把服务端错误拆成「逐字段原因 + 总提示」：
 * 422 validation_failed 时按 details.issues[].path 放到对应输入框下；
 * 其他错误（邮箱已注册、限流、网络断开…）显示服务端给的中文原因。
 */
export function splitApiErrors<F extends string>(
  err: unknown,
  fields: readonly F[],
  fallback: string,
): SplitErrors<F> {
  if (!(err instanceof ApiRequestError)) {
    return { fields: {}, form: err instanceof Error ? err.message : fallback };
  }
  if (err.isNetworkError) return { fields: {}, form: tr('连不上服务器，请检查网络后再试。') };
  const raw = err.details?.issues;
  const issues = Array.isArray(raw)
    ? raw.filter(
        (i): i is { path: string; message: string } =>
          typeof i === 'object' &&
          i !== null &&
          typeof (i as { path?: unknown }).path === 'string' &&
          typeof (i as { message?: unknown }).message === 'string',
      )
    : [];
  const out: Partial<Record<F, string>> = {};
  const rest: string[] = [];
  for (const issue of issues) {
    const key = issue.path.split('.')[0] as F;
    if (fields.includes(key)) out[key] ??= issue.message;
    else rest.push(issue.message);
  }
  if (Object.keys(out).length > 0) return { fields: out, form: rest[0] ?? null };
  return { fields: {}, form: err.message || fallback };
}
