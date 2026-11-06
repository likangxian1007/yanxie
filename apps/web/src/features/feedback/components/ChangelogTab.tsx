import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Megaphone, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  CHANGELOG_TAG_LABEL,
  parseTicketCode,
  type ChangelogEntry,
  type ChangelogTag,
} from '@srh/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  Markdown,
  Skeleton,
  Textarea,
  toast,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatFullTimeZh } from '@/lib/time';
import { useChangelog, useDeleteChangelog, useSaveChangelog } from '../api';
import { FEEDBACK_COPY } from '../copy';

const c = FEEDBACK_COPY.changelog;
const TAGS = Object.keys(CHANGELOG_TAG_LABEL) as ChangelogTag[];
const TAG_TONE: Record<ChangelogTag, 'success' | 'accent' | 'warning'> = {
  feature: 'success',
  improve: 'accent',
  fix: 'warning',
};
export const CHANGELOG_SEEN_KEY = 'srh.changelog.seen';

/** 最新一条已发布更新的时间（给「有新更新」小红点用）。 */
export function latestPublished(list: ChangelogEntry[] | undefined): string | null {
  let best: string | null = null;
  for (const e of list ?? [])
    if (e.publishedAt && (!best || e.publishedAt > best)) best = e.publishedAt;
  return best;
}

export function readChangelogSeen(): string {
  try {
    return window.localStorage.getItem(CHANGELOG_SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 「YX-12, 15」→ [12, 15]；有不合法的返回 null。 */
export function parseTicketNos(text: string): number[] | null {
  const parts = text.split(/[,，\s]+/u).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = /^\d+$/u.test(p) ? Number(p) : parseTicketCode(p);
    if (!n || !Number.isInteger(n) || n <= 0) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function EntryForm({ entry, onDone }: { entry: ChangelogEntry | null; onDone: () => void }) {
  const save = useSaveChangelog();
  const [version, setVersion] = useState(entry?.version ?? '');
  const [title, setTitle] = useState(entry?.title ?? '');
  const [body, setBody] = useState(entry?.body ?? '');
  const [tags, setTags] = useState<ChangelogTag[]>(entry?.tags ?? []);
  const [nos, setNos] = useState(entry?.tickets.map((t) => t.code).join(', ') ?? '');
  const [pr, setPr] = useState(entry?.prUrl ?? '');
  const ticketNos = parseTicketNos(nos);
  const valid = version.trim() && title.trim() && ticketNos;
  const isDraft = !entry || !entry.publishedAt;

  const submit = (publish: boolean) => {
    if (!valid) return;
    save.mutate(
      {
        id: entry?.id,
        input: {
          version: version.trim(),
          title: title.trim(),
          body,
          tags,
          ticketNos: ticketNos ?? [],
          prUrl: pr.trim() || null,
          ...(isDraft ? { publish } : {}),
        },
      },
      {
        onSuccess: () => {
          toast.success(publish ? c.published : c.saved);
          onDone();
        },
        onError: (e) => toast.error(c.failed, e instanceof Error ? e.message : undefined),
      },
    );
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit(true);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Input
          aria-label={c.version}
          placeholder={c.versionPlaceholder}
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          data-autofocus
        />
        <Input
          aria-label={c.titleLabel}
          placeholder={c.titleLabel}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">{c.tags}</legend>
        {TAGS.map((tag) => {
          const on = tags.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setTags(on ? tags.filter((x) => x !== tag) : [...tags, tag].slice(0, 3))
              }
              className={cn(
                'h-7 cursor-pointer rounded-sm border px-2.5 text-small max-md:h-11',
                on
                  ? 'border-accent-solid bg-accent-soft text-accent-text'
                  : 'border-line text-fg-muted hover:bg-subtle',
              )}
            >
              {CHANGELOG_TAG_LABEL[tag]}
            </button>
          );
        })}
      </fieldset>
      <Textarea
        aria-label={c.body}
        placeholder={c.body}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        autoGrow
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          aria-label={c.tickets}
          placeholder={c.ticketsPlaceholder}
          value={nos}
          onChange={(e) => setNos(e.target.value)}
          error={ticketNos ? undefined : c.ticketsInvalid}
        />
        <Input
          aria-label={c.pr}
          placeholder={c.pr}
          type="url"
          value={pr}
          onChange={(e) => setPr(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {c.cancel}
        </Button>
        {isDraft && (
          <Button
            type="button"
            disabled={!valid}
            loading={save.isPending}
            onClick={() => submit(false)}
          >
            {c.saveDraft}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={!valid} loading={save.isPending}>
          {isDraft ? c.publish : c.save}
        </Button>
      </div>
    </form>
  );
}

function Entry({
  e,
  isAdmin,
  onEdit,
}: {
  e: ChangelogEntry;
  isAdmin: boolean;
  onEdit: () => void;
}) {
  const del = useDeleteChangelog();
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="relative pb-8 pl-6 last:pb-0">
      <span
        aria-hidden
        className="absolute top-2 left-0 size-2.5 rounded-full bg-accent-solid ring-4 ring-canvas"
      />
      <span aria-hidden className="absolute top-5 bottom-0 left-[4.5px] w-px bg-line" />
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-small font-semibold text-fg tabular-nums">
          v{e.version}
        </span>
        <time className="text-small text-fg-subtle" dateTime={e.publishedAt ?? e.createdAt}>
          {formatFullTimeZh(e.publishedAt ?? e.createdAt)}
        </time>
        {!e.publishedAt && <Badge tone="warning">{c.draft}</Badge>}
        {e.tags.map((t) => (
          <Badge key={t} tone={TAG_TONE[t]}>
            {CHANGELOG_TAG_LABEL[t]}
          </Badge>
        ))}
        {isAdmin && (
          <span className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Pencil strokeWidth={1.75} aria-hidden />}
              onClick={onEdit}
            >
              {c.edit}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Trash2 strokeWidth={1.75} aria-hidden />}
              onClick={() => setConfirm(true)}
            >
              {c.remove}
            </Button>
          </span>
        )}
      </div>
      <h3 className="mt-1.5 text-h3 text-fg">{e.title}</h3>
      {e.body && (
        <Markdown size="compact" className="mt-2 text-fg-muted">
          {e.body}
        </Markdown>
      )}
      {(e.tickets.length > 0 || e.prUrl) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
          {e.tickets.map((t) => (
            <Link key={t.id} to={`/feedback/${t.no}`} className="text-accent-text hover:underline">
              <span className="font-mono tabular-nums">{t.code}</span> {t.title}
            </Link>
          ))}
          {e.prUrl && (
            <a
              href={e.prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent-text hover:underline"
            >
              {c.viewPr}
              <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
            </a>
          )}
        </div>
      )}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={c.removeConfirm}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {c.cancel}
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                del.mutate(e.id, {
                  onSuccess: () => {
                    setConfirm(false);
                    toast.success(c.removed);
                  },
                  onError: () => toast.error(c.failed),
                })
              }
            >
              {c.remove}
            </Button>
          </>
        }
      >
        <p className="text-small text-fg-muted">
          v{e.version} · {e.title}
        </p>
      </Dialog>
    </li>
  );
}

export function ChangelogTab({ isAdmin }: { isAdmin: boolean }) {
  const query = useChangelog();
  const [editing, setEditing] = useState<ChangelogEntry | 'new' | null>(null);
  const latest = latestPublished(query.data);

  // 打开就算看过
  useEffect(() => {
    if (!latest) return;
    try {
      window.localStorage.setItem(CHANGELOG_SEEN_KEY, latest);
      window.dispatchEvent(new Event('srh:changelog-seen'));
    } catch {
      // 忽略
    }
  }, [latest]);

  const list = query.data ?? [];
  return (
    <div className="flex max-w-(--doc-max) flex-col gap-6">
      {isAdmin && (
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
            onClick={() => setEditing('new')}
            className="max-md:h-11"
          >
            {c.publish}
          </Button>
        </div>
      )}
      {query.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : list.length === 0 ? (
        <EmptyState framed icon={Megaphone} title={c.empty} description={c.emptyHint} />
      ) : (
        <ol>
          {list.map((e) => (
            <Entry key={e.id} e={e} isAdmin={isAdmin} onEdit={() => setEditing(e)} />
          ))}
        </ol>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === 'new' ? c.publish : c.edit}
        size="lg"
      >
        {editing !== null && (
          <EntryForm entry={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
        )}
      </Dialog>
    </div>
  );
}
