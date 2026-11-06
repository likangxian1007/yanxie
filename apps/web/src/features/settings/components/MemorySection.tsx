import { useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { motion } from 'motion/react';
import { BookMarked, Plus } from 'lucide-react';
import { Badge, Button, Card, EmptyState, RelativeTime } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { canManage, useMyRole } from '@/lib/project';
import { MEMORY_TYPE_LABEL } from '../lib';
import { useMemoryList } from '../queries';
import { MemoryViewer } from './MemoryViewer';
import { NewMemoryDialog } from './NewMemoryDialog';
import { ErrorCard, ReadOnlyNote, SectionSkeleton, SettingsCard } from './parts';
import { tr, trServer } from '@/lib/i18n';

export function MemorySection({ pid }: { pid: string }) {
  const list = useMemoryList(pid);
  const editable = canManage(useMyRole(pid));
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const { variants, stagger } = useMotionPreset();

  const files = list.data ?? [];
  const requested = params.get('file');
  const selected =
    (requested && files.some((f) => f.path === requested) ? requested : files[0]?.path) ?? null;

  const select = (path: string | null, scroll = false) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (path) next.set('file', path);
        else next.delete('file');
        return next;
      },
      { replace: true },
    );
    // 手机上列表在上、内容在下：选中后滚到内容
    if (scroll && window.matchMedia('(max-width: 1023px)').matches) {
      window.requestAnimationFrame(() =>
        viewerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    }
  };

  const intro = (
    <SettingsCard
      title={tr('项目记忆')}
      description={tr('协调者和 agent 共享的长期记忆，改动保留版本。')}
      actions={
        editable ? (
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Plus strokeWidth={2} aria-hidden />}
            onClick={() => setCreating(true)}
          >
            {tr('新建记忆')}
          </Button>
        ) : (
          <ReadOnlyNote />
        )
      }
    />
  );

  let body: ReactNode;
  if (list.isPending) body = <SectionSkeleton rows={3} />;
  else if (list.isError)
    body = <ErrorCard error={list.error} onRetry={() => void list.refetch()} />;
  else if (files.length === 0)
    body = (
      <EmptyState
        framed
        icon={BookMarked}
        title={tr('还没有项目记忆')}
        description={tr(
          '写下项目约定、术语和决定，协调者和 agent 每次工作前都会参考。agent 也会自己记下重要信息。',
        )}
        action={
          editable ? (
            <Button
              variant="primary"
              leftIcon={<Plus strokeWidth={2} aria-hidden />}
              onClick={() => setCreating(true)}
            >
              {tr('新建记忆')}
            </Button>
          ) : undefined
        }
      />
    );
  else
    body = (
      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        <Card
          padding="none"
          className="min-w-0 overflow-hidden lg:sticky lg:top-[calc(var(--topbar-h)+4rem)]"
        >
          <p className="border-b border-line px-3 py-2 text-caption text-fg-subtle">
            {tr('{count} 个文件', { count: files.length })}
          </p>
          <motion.ul
            variants={stagger()}
            initial="hidden"
            animate="visible"
            aria-label={tr('记忆文件')}
            className="flex max-h-[24rem] flex-col gap-0.5 overflow-y-auto p-1 lg:max-h-[calc(100dvh-12rem)]"
          >
            {files.map((f) => {
              const active = f.path === selected;
              return (
                <motion.li key={f.path} variants={variants.fadeUp}>
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => select(f.path, true)}
                    className={cn(
                      'flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-sm px-2.5 py-2 text-left',
                      'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
                      active ? 'bg-accent-soft' : 'hover:bg-subtle',
                    )}
                  >
                    <span className="flex w-full min-w-0 items-center gap-1.5">
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate font-mono text-small',
                          active ? 'text-accent-text' : 'text-fg',
                        )}
                      >
                        {f.path}
                      </span>
                      {f.type && (
                        <Badge tone="neutral" className="h-4 px-1.5">
                          {MEMORY_TYPE_LABEL[f.type]}
                        </Badge>
                      )}
                    </span>
                    {f.description && (
                      <span className="line-clamp-2 text-caption font-normal text-fg-muted">
                        {f.description}
                      </span>
                    )}
                    <span className="truncate text-caption font-normal text-fg-subtle">
                      v{f.version} · {trServer(f.updatedBy.name)} ·{' '}
                      <RelativeTime iso={f.updatedAt} />
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </motion.ul>
        </Card>

        <div ref={viewerRef} className="min-w-0 scroll-mt-[calc(var(--topbar-h)+3.5rem)]">
          {selected && (
            <MemoryViewer
              key={selected}
              pid={pid}
              path={selected}
              editable={editable}
              onDeleted={() => select(null)}
            />
          )}
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      {intro}
      {body}
      {editable && (
        <NewMemoryDialog
          open={creating}
          onOpenChange={setCreating}
          pid={pid}
          existingPaths={files.map((f) => f.path)}
          onCreated={(f) => select(f.path, true)}
        />
      )}
    </div>
  );
}
