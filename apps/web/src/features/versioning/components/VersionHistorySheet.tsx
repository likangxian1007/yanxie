import { useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, History, RotateCcw, Save } from 'lucide-react';
import {
  VERSION_KIND_LABEL,
  type Version,
  type VersionKind,
  type VersionTargetKind,
} from '@srh/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  RelativeTime,
  Select,
  Sheet,
  Skeleton,
  Tabs,
  toast,
  type BadgeTone,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { useIsMobile } from '@/lib/use-media-query';
import {
  useCurrentContent,
  useRestoreVersion,
  useSaveVersion,
  useVersionContent,
  useVersions,
  useVersioningEvents,
} from '../api';
import { formatBytes } from '../lib';
import { ContentDiff, ContentPreview } from './ContentDiff';
import { tr, trServer } from '@/lib/i18n';

const KIND_TONE: Record<VersionKind, BadgeTone> = {
  manual: 'accent',
  auto: 'neutral',
  pre_restore: 'neutral',
  restore: 'warning',
  pre_merge: 'neutral',
  merge: 'agent',
};

const TARGET_NOUN: Record<VersionTargetKind, string> = {
  document: tr('文档'),
  notebook: 'notebook',
  file: tr('文件'),
};

type Mode = 'preview' | 'current' | 'other';

/**
 * 版本历史（文档、notebook、文件通用）：存为版本、浏览任意版本、与当前或另一个版本对比、回滚。
 * 回滚不会删掉任何版本：回滚前的内容和回滚结果都会各存一版。
 */
export function VersionHistorySheet({
  open,
  onOpenChange,
  pid,
  targetKind,
  targetId,
  title,
  editable,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pid: string;
  targetKind: VersionTargetKind;
  targetId: string;
  /** 对象标题（抽屉副标题） */
  title?: string;
  editable: boolean;
}) {
  useVersioningEvents(pid);
  const mobile = useIsMobile();
  const { variants } = useMotionPreset();
  const versions = useVersions(pid, targetKind, targetId, open);
  const save = useSaveVersion(pid, targetKind, targetId);
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const list = versions.data ?? [];
  const current = list.find((v) => v.id === selected) ?? null;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        // 关掉再打开时回到版本列表
        if (!o) setSelected(null);
        onOpenChange(o);
      }}
      side={mobile ? 'bottom' : 'right'}
      width="min(720px, 96vw)"
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0">{tr('版本历史')}</span>
          {title && <span className="truncate text-small font-normal text-fg-subtle">{title}</span>}
        </span>
      }
    >
      <div className="p-4">
        <AnimatePresence mode="wait" initial={false}>
          {current ? (
            <motion.div
              key={`v-${current.id}`}
              variants={variants.fadeIn}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <VersionDetail
                pid={pid}
                targetKind={targetKind}
                targetId={targetId}
                version={current}
                versions={list}
                editable={editable}
                onBack={() => setSelected(null)}
              />
            </motion.div>
          ) : (
            <motion.div
              key="list"
              variants={variants.fadeIn}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="flex flex-col gap-4"
            >
              {editable && (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save.mutate(note.trim(), {
                      onSuccess: () => {
                        setNote('');
                        toast({ title: tr('已存为版本'), tone: 'success' });
                      },
                      onError: (err) => toast({ title: errText(err), tone: 'danger' }),
                    });
                  }}
                >
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={tr('版本说明，例如：投稿前定稿')}
                    maxLength={200}
                    aria-label={tr('版本说明')}
                  />
                  <Button
                    type="submit"
                    variant="secondary"
                    className="shrink-0"
                    loading={save.isPending}
                    leftIcon={<Save size={14} strokeWidth={1.75} aria-hidden />}
                  >
                    {tr('存为版本')}
                  </Button>
                </form>
              )}
              <p className="text-caption text-fg-subtle">
                {tr('编辑时每隔几分钟自动存一版；回滚、合入改动提案前后也会各存一版，历史不会丢。')}
              </p>

              {versions.isPending ? (
                <div className="flex flex-col gap-2" role="status" aria-label={tr('正在加载版本')}>
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-14 w-full rounded-md" />
                  ))}
                </div>
              ) : versions.isError ? (
                <div className="flex items-center gap-3 rounded-md bg-danger-soft px-3 py-2.5 text-small text-danger">
                  <span className="min-w-0 flex-1">
                    {tr('版本列表没有加载出来：{value}', { value: errText(versions.error) })}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void versions.refetch()}>
                    {tr('重试')}
                  </Button>
                </div>
              ) : list.length === 0 ? (
                <EmptyState
                  icon={History}
                  title={tr('还没有版本')}
                  description={tr('{value}被编辑后会自动存版本；关键节点也可以手动存一版。', {
                    value: TARGET_NOUN[targetKind],
                  })}
                />
              ) : (
                <ol className="flex flex-col">
                  {list.map((v, i) => (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(v.id)}
                        className="group flex w-full min-w-0 items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors duration-(--dur-fast) hover:bg-subtle focus-visible:bg-subtle"
                      >
                        <span
                          aria-hidden
                          className={cn(
                            'mt-1.5 size-2 shrink-0 rounded-full',
                            i === 0 ? 'bg-accent' : 'bg-line-strong',
                          )}
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-body text-fg">{v.note}</span>
                            <Badge tone={KIND_TONE[v.kind]} className="shrink-0">
                              {VERSION_KIND_LABEL[v.kind]}
                            </Badge>
                          </span>
                          <span className="text-caption text-fg-subtle">
                            {trServer(v.createdBy.name)} · <RelativeTime iso={v.createdAt} />
                            {i === 0 && tr(' · 最新')}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Sheet>
  );
}

function VersionDetail({
  pid,
  targetKind,
  targetId,
  version,
  versions,
  editable,
  onBack,
}: {
  pid: string;
  targetKind: VersionTargetKind;
  targetId: string;
  version: Version;
  versions: Version[];
  editable: boolean;
  onBack: () => void;
}) {
  const index = versions.findIndex((v) => v.id === version.id);
  const older = versions[index + 1] ?? null;
  const [mode, setMode] = useState<Mode>('current');
  const [otherId, setOtherId] = useState<string | null>(older?.id ?? null);
  const [confirm, setConfirm] = useState(false);
  const detail = useVersionContent(pid, version.id);
  const other = useVersionContent(pid, mode === 'other' ? otherId : null);
  const cur = useCurrentContent(pid, targetKind, targetId, mode === 'current');
  const restore = useRestoreVersion(pid, targetKind, targetId);

  const otherOptions = useMemo(
    () =>
      versions
        .filter((v) => v.id !== version.id)
        .map((v) => ({
          value: v.id,
          label: `${shortTime(v.createdAt)} · ${v.note}`.slice(0, 60),
        })),
    [versions, version.id],
  );

  const otherVersion = versions.find((v) => v.id === otherId);
  // 和别的版本比时，旧的放左边
  const otherIsOlder = otherVersion ? otherVersion.createdAt <= version.createdAt : true;

  let body: ReactNode;
  if (detail.isPending) body = <BodySkeleton />;
  else if (detail.isError)
    body = <ErrorLine err={detail.error} onRetry={() => void detail.refetch()} />;
  else if (mode === 'preview') body = <ContentPreview content={detail.data.content} />;
  else if (mode === 'current') {
    body = cur.isPending ? (
      <BodySkeleton />
    ) : cur.isError ? (
      <ErrorLine err={cur.error} onRetry={() => void cur.refetch()} />
    ) : (
      <ContentDiff before={detail.data.content} after={cur.data} />
    );
  } else if (!otherId) {
    body = <p className="text-small text-fg-subtle">{tr('只有这一个版本，没有可以对比的。')}</p>;
  } else {
    body = other.isPending ? (
      <BodySkeleton />
    ) : other.isError ? (
      <ErrorLine err={other.error} onRetry={() => void other.refetch()} />
    ) : (
      <ContentDiff
        before={otherIsOlder ? other.data.content : detail.data.content}
        after={otherIsOlder ? detail.data.content : other.data.content}
      />
    );
  }

  const caption =
    mode === 'current'
      ? tr('这个版本 → 当前内容')
      : mode === 'other' && otherVersion
        ? otherIsOlder
          ? tr('{value} → 这个版本', { value: shortTime(otherVersion.createdAt) })
          : tr('这个版本 → {value}', { value: shortTime(otherVersion.createdAt) })
        : tr('这个版本的内容');

  return (
    <div className="flex flex-col gap-4">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-small text-fg-muted hover:text-fg"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
          {tr('全部版本')}
        </button>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <h3 className="flex min-w-0 items-center gap-2 text-h3 text-fg">
            <span className="min-w-0 break-words">{version.note}</span>
            <Badge tone={KIND_TONE[version.kind]} className="shrink-0">
              {VERSION_KIND_LABEL[version.kind]}
            </Badge>
          </h3>
          <p className="mt-1 text-caption text-fg-subtle">
            {trServer(version.createdBy.name)} · <RelativeTime iso={version.createdAt} /> ·{' '}
            {formatBytes(version.size)}
          </p>
        </div>
        {editable && (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<RotateCcw size={14} strokeWidth={1.75} aria-hidden />}
            onClick={() => setConfirm(true)}
          >
            {tr('回滚到此版本')}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          variant="segmented"
          size="sm"
          aria-label={tr('查看方式')}
          layoutId="version-detail-mode"
          value={mode}
          onValueChange={setMode}
          items={[
            { value: 'current' as const, label: tr('对比当前') },
            { value: 'other' as const, label: tr('对比其他版本') },
            { value: 'preview' as const, label: tr('内容') },
          ]}
        />
        {mode === 'other' && otherOptions.length > 0 && (
          <Select
            size="sm"
            aria-label={tr('对比的版本')}
            wrapperClassName="w-auto min-w-0 flex-1 basis-48"
            value={otherId ?? ''}
            onChange={(e) => setOtherId(e.target.value)}
            options={otherOptions}
          />
        )}
      </div>
      <p className="-mt-2 text-caption text-fg-subtle">{caption}</p>
      <div className="min-w-0">{body}</div>

      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        size="sm"
        title={tr('回滚到这个版本？')}
        description={tr(
          '当前内容会先存进历史，回滚结果也会存成一个新版本，之后随时可以再切回来。正在编辑的人会立即看到变化。',
        )}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {tr('取消')}
            </Button>
            <Button
              variant="primary"
              loading={restore.isPending}
              onClick={() =>
                restore.mutate(version.id, {
                  onSuccess: ({ backup }) => {
                    setConfirm(false);
                    toast({
                      title: tr('已回滚'),
                      description:
                        backup.kind === 'pre_restore'
                          ? tr('回滚前的内容存成了「回滚前备份」')
                          : tr('回滚前的内容与「{note}」相同，仍在历史里', { note: backup.note }),
                      tone: 'success',
                    });
                    onBack();
                  },
                  onError: (err) => toast({ title: errText(err), tone: 'danger' }),
                })
              }
            >
              {tr('回滚')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </div>
  );
}

function BodySkeleton() {
  return (
    <div role="status" aria-label={tr('正在加载内容')} className="flex flex-col gap-2">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

function ErrorLine({ err, onRetry }: { err: unknown; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-danger-soft px-3 py-2.5 text-small text-danger">
      <span className="min-w-0 flex-1">{tr('没有加载出来：{value}', { value: errText(err) })}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        {tr('重试')}
      </Button>
    </div>
  );
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return tr('{value}月{d}日 {value2}:{value3}', {
    value: d.getMonth() + 1,
    d: d.getDate(),
    value2: pad(d.getHours()),
    value3: pad(d.getMinutes()),
  });
}

function errText(err: unknown) {
  return err instanceof ApiRequestError ? err.message : tr('请稍后再试');
}
