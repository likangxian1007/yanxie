import {
  forwardRef,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import { PageTitleValue, PageTitleSetter } from './page-title';

export type PageWidth = 'feed' | 'doc' | 'full';

export interface PageProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** feed = 聊天流/线程（800），doc = 文档（820），full = 看板/表格（全宽） */
  width?: PageWidth;
}

const WIDTH: Record<PageWidth, string> = {
  feed: 'max-w-(--feed-max)',
  doc: 'max-w-(--doc-max)',
  full: 'max-w-none',
};

/** 页面容器：统一页边距（手机 16 / 桌面 24）与最大宽度。 */
export const Page = forwardRef<HTMLDivElement, PageProps>(function Page(
  { width = 'feed', className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'mx-auto flex w-full flex-1 flex-col px-4 pt-5 pb-10 md:px-6 md:pt-6',
        WIDTH[width],
        className,
      )}
      {...props}
    />
  );
});

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** 右侧操作区（按钮） */
  actions?: ReactNode;
  /** 标题上方的小字（返回链接、所属分组） */
  eyebrow?: ReactNode;
}

/** 页面标题交给上下文工具栏；独立页面保留标题区。 */
export const PageHeader = forwardRef<HTMLDivElement, PageHeaderProps>(function PageHeader(
  { title, description, actions, eyebrow, className, ...props },
  ref,
) {
  const inShell = useContext(PageTitleSetter) !== null;
  if (inShell)
    return (
      <>
        <PageTitle>{title}</PageTitle>
        {actions && <PageActions>{actions}</PageActions>}
        {eyebrow && (
          <div ref={ref} className="mb-3" {...props}>
            {eyebrow}
          </div>
        )}
      </>
    );
  return (
    <div
      ref={ref}
      className={cn(
        'mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        {eyebrow && <div className="mb-2">{eyebrow}</div>}
        <h1 className="text-h1 text-fg">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-[38em] text-small text-pretty text-fg-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
});

/** 宽屏操作放入上下文顶栏；窄屏和独立页面在内容开头换行展示。 */
const subscribeActions = () => () => {};
const getActionSlot = () => document.getElementById('page-actions');

export function PageActions({ children }: { children: ReactNode }) {
  const slot = useSyncExternalStore(subscribeActions, getActionSlot, () => null);
  const compact = useMediaQuery('(max-width: 1279px)');
  if (slot && !compact) return createPortal(children, slot);
  return <div className="mb-4 flex flex-wrap items-center gap-2">{children}</div>;
}

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<ReactNode>(null);
  return (
    <PageTitleSetter value={setTitle}>
      <PageTitleValue value={title}>{children}</PageTitleValue>
    </PageTitleSetter>
  );
}

/** 动态内容标题交给外壳，独立渲染时仍保留页面的 H1。 */
export function PageTitle({ children }: { children: ReactNode }) {
  const setTitle = useContext(PageTitleSetter);
  useEffect(() => {
    setTitle?.(children);
    return () => setTitle?.(null);
  }, [children, setTitle]);
  return setTitle ? null : <h1 className="text-h1 text-fg">{children}</h1>;
}
