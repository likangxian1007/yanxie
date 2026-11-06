import { memo, type ReactNode } from 'react';
import { Link, useInRouterContext, useParams } from 'react-router';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/cn';
import {
  findRefElement,
  flashElement,
  parseLinkRef,
  prefersReducedMotion,
} from '@/lib/message-link';
import { internalHref } from '@/lib/outputs';

export interface MarkdownProps {
  children: string;
  className?: string;
  /** prose = 15/26（聊天、文档）；compact = 14/22（卡片、列表摘要） */
  size?: 'prose' | 'compact';
}

const LINK_CLS = 'font-medium text-accent-text underline-offset-2 hover:underline';

/** agent 正文里的 [标题](#thr_…) 之类站内引用 → 路由跳转 */
function InternalLink({
  to,
  refId,
  children,
}: {
  to: string;
  refId?: string | undefined;
  children: ReactNode;
}) {
  if (to.startsWith('#')) {
    return (
      <a
        href={to}
        className={LINK_CLS}
        onClick={(e) => {
          const el = document.getElementById(to.slice(1));
          if (!el) return;
          e.preventDefault();
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <Link
      to={to}
      className={LINK_CLS}
      onClick={(e) => {
        // #msg_ / #dec_：消息就在当前页面上时直接滚过去并闪一下，不经过跳转页
        if (!refId || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        const el = findRefElement(refId);
        if (!el) return;
        e.preventDefault();
        flashElement(el, prefersReducedMotion());
      }}
    >
      {children}
    </Link>
  );
}

function MarkdownLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const { projectId } = useParams();
  const inRouter = useInRouterContext();
  if (inRouter && projectId && href?.startsWith('#')) {
    const to = internalHref(projectId, href);
    const ref = parseLinkRef(href);
    if (to)
      return (
        <InternalLink to={to} refId={ref?.id}>
          {children}
        </InternalLink>
      );
  }
  const external = typeof href === 'string' && /^https?:/u.test(href);
  return (
    <a
      href={href}
      className={LINK_CLS}
      {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
    >
      {children}
    </a>
  );
}

const components: Components = {
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  code: ({ node: _node, className, children, ...props }) => {
    const block = /language-/u.test(className ?? '');
    return block ? (
      <code className={cn('font-mono text-small', className)} {...props}>
        {children}
      </code>
    ) : (
      <code className="rounded-xs bg-muted px-1 py-0.5 font-mono text-[0.85em] text-fg" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ node: _node, className, ...props }) => (
    <pre
      className={cn(
        'my-3 overflow-x-auto rounded-md border border-line bg-subtle px-3 py-2.5 text-small leading-relaxed',
        className,
      )}
      {...props}
    />
  ),
  table: ({ node: _node, className, ...props }) => (
    <div className="my-3 overflow-x-auto rounded-md border border-line">
      <table className={cn('w-full border-collapse text-small', className)} {...props} />
    </div>
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      className={cn(
        'border-b border-line bg-subtle px-3 py-1.5 text-left font-semibold',
        className,
      )}
      {...props}
    />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td className={cn('border-b border-line px-3 py-1.5 tabular-nums', className)} {...props} />
  ),
};

/**
 * Markdown 渲染（GFM：表格、任务列表、删除线）。只用语义色；不渲染原始 HTML。
 * 中文正文段距 0.75em、列表项 0.25em（STYLE §2）。
 */
export const Markdown = memo(function Markdown({
  children,
  className,
  size = 'prose',
}: MarkdownProps) {
  return (
    <div
      className={cn(
        'min-w-0 break-words text-fg',
        size === 'prose' ? 'text-prose' : 'text-body',
        '[&_p]:my-[0.75em] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_ul]:my-[0.75em] [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-[0.75em] [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:my-[0.25em] [&_li::marker]:text-fg-subtle',
        '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-h2 [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-h3 [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-h3',
        '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-fg-muted',
        '[&_hr]:my-4 [&_hr]:border-line',
        '[&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:accent-(--accent)',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
