import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { Markdown } from '@/components/ui';
import { parseReportRef, reportRefPath } from '../lib/links';

/**
 * 汇报正文的 Markdown：在通用 <Markdown> 外层接管 `#tdo_` / `#rev_` / `#elg_` 链接的点击
 * （通用渲染把它们当页内锚点，点了没反应），改成站内路由跳转。其余链接照旧。
 */
export function ReportMarkdown({ pid, children }: { pid: string; children: string }) {
  const navigate = useNavigate();

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as HTMLElement).closest('a');
    if (!a || !e.currentTarget.contains(a)) return;
    const ref = parseReportRef(a.getAttribute('href'));
    if (!ref) return;
    e.preventDefault();
    const newTab = e.metaKey || e.ctrlKey;
    const go = (path: string) => {
      if (newTab) window.open(path, '_blank', 'noopener');
      else navigate(path);
    };
    const path = reportRefPath(pid, ref);
    if (path) {
      go(path);
      return;
    }
    go(`/p/${pid}/experiments`);
  };

  return (
    // 只是事件委托：键盘回车在 <a> 上同样会触发 click
    <div onClick={onClick}>
      <Markdown>{children}</Markdown>
    </div>
  );
}
