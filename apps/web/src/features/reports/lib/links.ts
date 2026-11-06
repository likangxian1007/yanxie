/**
 * 汇报正文里的站内引用 `[文字](#id)`：通用渲染（lib/outputs.ts internalHref）认得 thr_/doc_/exp_/rpt_，
 * 这里补上汇报里常见、但通用渲染还不认识的几类：
 * - tdo_ → 待办页并高亮这一条（/todos?todo=）
 * - rev_ → 审阅详情
 * - elg_ → 实验日志：要先查出它属于哪个实验（GET P/experiment-logs/:id），再跳到实验页并定位
 * msg_ / dec_（消息、决策卡）由通用渲染处理：先到跳转页查出所在的时间线或线程再跳过去
 * （lib/message-link.ts），这里不拦截。
 */
export type ReportRef =
  | { kind: 'todo'; id: string }
  | { kind: 'review'; id: string }
  | { kind: 'experimentLog'; id: string };

const PREFIX: Record<string, ReportRef['kind']> = {
  tdo_: 'todo',
  rev_: 'review',
  elg_: 'experimentLog',
};

/** `#tdo_…` / `tdo_…` → 引用；不是这几类返回 null */
export function parseReportRef(href: string | null | undefined): ReportRef | null {
  if (!href) return null;
  const id = href.replace(/^#/u, '').trim();
  if (!/^[a-z]{3}_[0-9A-Za-z]+$/u.test(id)) return null;
  const kind = PREFIX[id.slice(0, 4)];
  return kind ? { kind, id } : null;
}

/** 不需要再查询就能算出的路由；experimentLog 需要先查实验 id，返回 null */
export function reportRefPath(pid: string, ref: ReportRef): string | null {
  switch (ref.kind) {
    case 'todo':
      return `/p/${pid}/todos?todo=${encodeURIComponent(ref.id)}`;
    case 'review':
      return `/p/${pid}/reviews/${ref.id}`;
    case 'experimentLog':
      return `/p/${pid}/experiments`;
  }
}

export function experimentLogPath(pid: string, experimentId: string, logId: string): string {
  return `/p/${pid}/experiments/${experimentId}?log=${encodeURIComponent(logId)}`;
}
