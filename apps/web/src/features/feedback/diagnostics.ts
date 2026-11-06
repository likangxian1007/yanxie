import type { FeedbackContext } from '@srh/shared';
import type { ClientErrorEntry } from '@/lib/client-errors';
import { FEEDBACK_COPY } from './copy';
import { tr } from '@/lib/i18n';

/** 提交反馈时采集的现场信息（比 FeedbackContext 多主题和课题名，这两项只写进日志文本）。 */
export interface Diagnostics {
  url: string;
  route: string;
  projectId?: string | undefined;
  projectName?: string | undefined;
  threadId?: string | undefined;
  userAgent: string;
  viewport: string;
  theme: string;
  appVersion?: string | undefined;
  errors: ClientErrorEntry[];
}

/** 去掉 query 里可能带的 token / code 之类参数，只留路径。 */
export function stripSensitive(url: string): string {
  const i = url.search(/[?#]/u);
  return i === -1 ? url : url.slice(0, i);
}

/** 从路径里猜课题和对话 id：/p/:projectId/... 与 ?thread= 或 /t/:threadId。 */
export function idsFromLocation(pathname: string, search: string) {
  const project = /\/p\/([^/?#]+)/u.exec(pathname)?.[1];
  const threadPath = /\/(?:t|threads)\/(thr_[^/?#]+)/u.exec(pathname)?.[1];
  const threadQuery = new URLSearchParams(search).get('thread') ?? undefined;
  return {
    projectId: project ? decodeURIComponent(project) : undefined,
    threadId: threadPath ?? threadQuery,
  };
}

function errorLine(e: ClientErrorEntry): string {
  return `[${e.at}] ${e.source} ${e.route} — ${e.message}`;
}

export function toFeedbackContext(d: Diagnostics): FeedbackContext {
  const ctx: FeedbackContext = {
    url: d.url.slice(0, 2000),
    route: d.route.slice(0, 300),
    userAgent: d.userAgent.slice(0, 500),
    viewport: d.viewport.slice(0, 40),
  };
  if (d.projectId) ctx.projectId = d.projectId.slice(0, 64);
  if (d.threadId) ctx.threadId = d.threadId.slice(0, 64);
  if (d.appVersion) ctx.appVersion = d.appVersion.slice(0, 80);
  const recent = d.errors.slice(-10).map((e) => errorLine(e).slice(0, 1000));
  if (recent.length) ctx.recentErrors = recent;
  return ctx;
}

/** 预览里逐行展示的条目。 */
export function diagnosticRows(d: Diagnostics): { label: string; value: string }[] {
  const c = FEEDBACK_COPY.diag;
  const project = d.projectName
    ? `${d.projectName}${d.projectId ? tr('（{projectId}）', { projectId: d.projectId }) : ''}`
    : (d.projectId ?? c.none);
  return [
    { label: c.route, value: d.route },
    { label: c.project, value: project },
    { label: c.thread, value: d.threadId ?? c.none },
    { label: c.browser, value: d.userAgent },
    { label: c.viewport, value: d.viewport },
    { label: c.theme, value: d.theme },
    { label: c.version, value: d.appVersion ?? c.none },
    { label: c.errors, value: d.errors.length ? tr('{n} 条', { n: d.errors.length }) : c.none },
  ];
}

/** 作为 logs 附件上传的纯文本。 */
export function diagnosticsText(d: Diagnostics, now = new Date()): string {
  const lines = [tr('研协诊断信息 · {now}', { now: now.toISOString() }), ''];
  for (const row of diagnosticRows(d))
    lines.push(tr('{label}：{value}', { label: row.label, value: row.value }));
  lines.push(tr('地址：{url}', { url: d.url }));
  if (d.errors.length) {
    lines.push('', tr('{errors}（新的在后）：', { errors: FEEDBACK_COPY.diag.errors }));
    for (const e of d.errors) {
      lines.push(errorLine(e));
      if (e.stack)
        lines.push(
          ...e.stack
            .split('\n')
            .slice(0, 8)
            .map((s) => `    ${s.trim()}`),
        );
    }
  }
  return `${lines.join('\n')}\n`;
}
