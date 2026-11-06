import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ChevronDown, ImagePlus } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FEEDBACK_IMAGE_MIMES,
  FEEDBACK_MAX_ATTACHMENTS,
  TICKET_BODY_MAX,
  TICKET_TITLE_MAX,
  type TicketDetail,
  type TicketKind,
} from '@srh/shared';
import { Button, Dialog, Input, Sheet, Switch, Tabs, Textarea, toast } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { appVersion, recentClientErrors } from '@/lib/client-errors';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/session';
import { useThemeStore } from '@/lib/theme';
import { useIsMobile } from '@/lib/use-media-query';
import { feedbackKeys } from '../api';
import { FEEDBACK_COPY } from '../copy';
import {
  diagnosticRows,
  diagnosticsText,
  idsFromLocation,
  stripSensitive,
  toFeedbackContext,
  type Diagnostics,
} from '../diagnostics';
import { useFeedbackDialog } from '../feedback-store';
import { imagesFromClipboard, useImageList } from '../image-files';
import { ImageThumbs } from './ImageThumbs';

const c = FEEDBACK_COPY.dialog;
const KINDS: TicketKind[] = ['bug', 'idea', 'question'];

/** 挂在各个外壳里：响应全局 store 打开，Alt+B 也在这里监听。 */
export function FeedbackDialogHost() {
  const open = useFeedbackDialog((s) => s.open);
  const setOpen = useFeedbackDialog((s) => s.setOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.code !== 'KeyB' && e.key.toLowerCase() !== 'b') return;
      // 其他对话框开着时不叠一层
      if (!useFeedbackDialog.getState().open && document.querySelector('[aria-modal="true"]'))
        return;
      e.preventDefault();
      setOpen(!useFeedbackDialog.getState().open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  return <FeedbackDialog open={open} onOpenChange={setOpen} />;
}

function useDiagnostics(open: boolean): Diagnostics | null {
  const location = useLocation();
  const me = useMe();
  const theme = useThemeStore((s) => `${s.resolved} · ${s.palette} · ${s.material}`);
  // 打开那一刻的快照，之后报错不再跳动
  return useMemo(() => {
    if (!open) return null;
    const { projectId, threadId } = idsFromLocation(location.pathname, location.search);
    const projectName = projectId
      ? me.data?.projects.find((p) => p.id === projectId)?.name
      : undefined;
    return {
      url: stripSensitive(window.location.href),
      route: location.pathname,
      projectId,
      projectName,
      threadId,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      theme,
      appVersion: appVersion(),
      errors: recentClientErrors(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时取一次
  }, [open]);
}

export function FeedbackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const formId = useId();
  const diag = useDiagnostics(open);

  const [kind, setKind] = useState<TicketKind>('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [withDiag, setWithDiag] = useState(true);
  const [showDiag, setShowDiag] = useState(false);
  const [titleError, setTitleError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const shots = useImageList();
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setKind('bug');
    setTitle('');
    setBody('');
    setWithDiag(true);
    setShowDiag(false);
    setTitleError(undefined);
    shots.clear();
  };

  const submit = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append('kind', kind);
      form.append('title', title.trim());
      form.append('body', body);
      if (diag?.projectId) form.append('projectId', diag.projectId);
      if (withDiag && diag) {
        form.append('context', JSON.stringify(toFeedbackContext(diag)));
        form.append(
          'logs',
          new File([diagnosticsText(diag)], 'diagnostics.txt', { type: 'text/plain' }),
        );
      }
      for (const s of shots.images) form.append('files', s.file, s.file.name);
      return api.post<TicketDetail>('/feedback/tickets', form);
    },
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: feedbackKeys.ticketsRoot });
      toast({
        title: c.submitted(t.code),
        tone: 'success',
        action: { label: c.view, onClick: () => navigate(`/feedback/${t.no}`) },
        duration: 8000,
      });
      reset();
      onOpenChange(false);
    },
    onError: (e) => {
      const desc = e instanceof ApiRequestError && e.status === 415 ? c.badType : e.message;
      toast.error(c.failed, desc);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setTitleError(c.titleRequired);
      return;
    }
    submit.mutate();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    shots.add(Array.from(e.dataTransfer.files));
  };

  const content = (
    <form
      id={formId}
      onSubmit={onSubmit}
      onPaste={(e) => {
        const files = imagesFromClipboard(e.clipboardData);
        if (files.length) {
          e.preventDefault();
          shots.add(files);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      className={cn('relative flex flex-col gap-4', mobile && 'px-4 pt-1 pb-4')}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-small font-medium text-fg">{c.kind}</span>
        <Tabs
          variant="segmented"
          layoutId="feedback-kind"
          aria-label={c.kind}
          value={kind}
          onValueChange={setKind}
          items={KINDS.map((k) => ({ value: k, label: FEEDBACK_COPY.kindShort[k] }))}
          className="self-start"
        />
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-small font-medium text-fg">{c.titleLabel}</span>
        <Input
          data-autofocus
          value={title}
          maxLength={TICKET_TITLE_MAX}
          placeholder={c.titlePlaceholder}
          error={titleError}
          onChange={(e) => {
            setTitle(e.target.value);
            if (titleError) setTitleError(undefined);
          }}
          onFocus={(e) => mobile && e.currentTarget.scrollIntoView({ block: 'center' })}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-small font-medium text-fg">{c.body}</span>
        <Textarea
          value={body}
          rows={mobile ? 3 : 5}
          autoGrow
          maxLength={TICKET_BODY_MAX}
          placeholder={c.bodyPlaceholder}
          onChange={(e) => setBody(e.target.value)}
          onFocus={(e) => mobile && e.currentTarget.scrollIntoView({ block: 'center' })}
        />
      </label>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-small font-medium text-fg">
            {c.shots}
            <span className="ml-2 font-normal text-fg-subtle tabular-nums">
              {shots.images.length}/{FEEDBACK_MAX_ATTACHMENTS}
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            leftIcon={<ImagePlus strokeWidth={1.75} aria-hidden />}
            disabled={shots.full}
            onClick={() => fileRef.current?.click()}
            className="max-md:h-11"
          >
            {c.addShot}
          </Button>
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            accept={FEEDBACK_IMAGE_MIMES.join(',')}
            onChange={(e) => {
              shots.add(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
        {shots.images.length === 0 ? (
          <p className="text-small text-fg-subtle">{c.shotsHint(FEEDBACK_MAX_ATTACHMENTS)}</p>
        ) : (
          <ImageThumbs images={shots.images} onRemove={shots.remove} />
        )}
      </div>

      <div className="rounded-lg border border-line">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-small font-medium text-fg">{c.diagnostics}</p>
            <p className="text-small text-fg-subtle">{c.diagnosticsHint}</p>
          </div>
          <Switch checked={withDiag} onCheckedChange={setWithDiag} label={c.diagnostics} />
        </div>
        {withDiag && diag && (
          <>
            <button
              type="button"
              aria-expanded={showDiag}
              onClick={() => setShowDiag((v) => !v)}
              className="flex w-full cursor-pointer items-center gap-1 border-t border-line px-3 py-2 text-small text-fg-muted hover:text-fg max-md:h-11"
            >
              <ChevronDown
                size={16}
                strokeWidth={1.75}
                aria-hidden
                className={cn(
                  'transition-transform duration-(--dur-fast)',
                  showDiag && 'rotate-180',
                )}
              />
              {showDiag ? c.hidePreview : c.preview}
            </button>
            {showDiag && (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-line px-3 py-2.5 text-small">
                {diagnosticRows(diag).map((row) => (
                  <div key={row.label} className="contents">
                    <dt className="text-fg-subtle">{row.label}</dt>
                    <dd className="break-words text-fg-muted">{row.value}</dd>
                  </div>
                ))}
                {diag.errors.slice(-5).map((e, i) => (
                  <dd
                    key={`${e.at}-${i}`}
                    className="col-span-2 truncate font-mono text-caption text-danger"
                    title={e.message}
                  >
                    {e.message}
                  </dd>
                ))}
              </dl>
            )}
          </>
        )}
      </div>

      {dragging && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/80 text-body font-medium text-accent-text"
        >
          {c.dropHere}
        </div>
      )}
    </form>
  );

  const footer = (
    <div className="flex w-full justify-end gap-2">
      <Button
        type="button"
        variant="ghost"
        onClick={() => onOpenChange(false)}
        className="max-md:h-11"
      >
        {c.cancel}
      </Button>
      <Button
        type="submit"
        variant="primary"
        form={formId}
        loading={submit.isPending}
        className="max-md:h-11"
      >
        {c.submit}
      </Button>
    </div>
  );

  if (mobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} side="bottom" title={c.title} footer={footer}>
        {content}
      </Sheet>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={c.title}
      description={c.description}
      size="md"
      footer={footer}
    >
      {content}
    </Dialog>
  );
}
