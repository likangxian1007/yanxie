import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnnotationColor, PaperAnnotation } from '@srh/shared';
import { Badge, Button, Dialog, Input, Select, toast } from '@/components/ui';
import { notesKey } from '../notes-api';
import { ApiRequestError } from '@/lib/api';
import { annotationApi, annotationsKey, usePaperAnnotations } from '../annotations-api';
import { ANNOTATION_COLORS, annotationLabel } from '../lib/annotations';
import { useReader } from '../lib/reader';
import { isPersonalLibrary } from '../lib/scope';
import { AnnotationBodyEditor } from './AnnotationBodyEditor';
import { tr, trServer } from '@/lib/i18n';

export function AnnotationsPanel({
  activeId,
  onSelect,
  onJump,
  onOpenNotes,
}: {
  activeId: string;
  onSelect: (id: string) => void;
  onJump: (annotation: PaperAnnotation, revealPdf?: boolean) => void;
  onOpenNotes?: () => void;
}) {
  const { scope, paper, editable } = useReader();
  const writable = editable && !paper.archivedAt;
  const query = usePaperAnnotations(scope, paper.id);
  const qc = useQueryClient();
  const [showDeleted, setShowDeleted] = useState(false);
  const [editing, setEditing] = useState<{
    row: PaperAnnotation;
    color: AnnotationColor;
    label: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<PaperAnnotation | null>(null);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState<PaperAnnotation | null>(null);
  const [busy, setBusy] = useState(false);
  const active = query.data?.find((a) => a.id === activeId);
  const rows = query.data?.filter((a) => (showDeleted ? Boolean(a.deletedAt) : !a.deletedAt)) ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: annotationsKey(scope, paper.id) });
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setCurrent(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiRequestError && e.details?.current)
        setCurrent(e.details.current as PaperAnnotation);
      void refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <p className="text-small text-fg-muted">
        {isPersonalLibrary(scope)
          ? tr('个人高亮和批注仅自己可见；发布时分别选择。')
          : tr('项目成员共同维护这份副本，个人原件不受影响。')}
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-small">
          {showDeleted ? tr('已删除标注') : tr('阅读标注')} · {rows.length}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setShowDeleted((v) => !v)}>
          {showDeleted ? tr('返回标注列表') : tr('查看已删除')}
        </Button>
      </div>
      {query.isPending && <p role="status">{tr('正在读取标注…')}</p>}
      {query.error && (
        <div role="alert">
          <p>{query.error.message}</p>
          <Button onClick={() => void query.refetch()}>{tr('重试')}</Button>
        </div>
      )}
      {!query.isPending && !query.error && !rows.length && (
        <p className="text-small text-fg-muted">
          {showDeleted
            ? tr('没有已删除的标注。')
            : tr('还没有标注。在 PDF 中选中文字，再点击选区旁的“高亮”或“批注”。')}
        </p>
      )}
      <ul className="space-y-2" aria-label={tr('标注列表')}>
        {rows.map((a) => (
          <li key={a.id} className="overflow-hidden rounded-md border border-line">
            <button
              type="button"
              aria-expanded={activeId === a.id}
              aria-controls={activeId === a.id ? `annotation-detail-${a.id}` : undefined}
              className="w-full p-2.5 text-left hover:bg-subtle aria-expanded:bg-accent-soft focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
              onClick={() => {
                const opening = activeId !== a.id;
                onSelect(opening ? a.id : '');
                if (
                  opening &&
                  !a.deletedAt &&
                  a.anchorStatus === 'current' &&
                  a.fileId === paper.fileId
                )
                  onJump(a, false);
              }}
            >
              <span className="flex items-start gap-1.5 text-small font-medium">
                {activeId === a.id ? (
                  <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden />
                ) : (
                  <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 wrap-anywhere">{annotationLabel(a)}</span>
              </span>
              <span className="mt-1 block line-clamp-2 text-small text-fg-muted wrap-anywhere">
                {a.quote}
              </span>
              <span className="mt-1 block text-caption text-fg-muted">
                {ANNOTATION_COLORS[a.color]} · {trServer(a.createdBy.name)}
                {a.deletedAt ? tr(' · 已删除') : ''}
                {a.anchorStatus === 'mismatch' || a.fileId !== paper.fileId
                  ? tr(' · 原文版本不同／定位待确认')
                  : ''}
              </span>
            </button>
            {active?.id === a.id && (
              <section
                id={`annotation-detail-${a.id}`}
                className="mx-2 mb-2 space-y-2 rounded-md border-l-2 border-line bg-subtle p-3 text-small"
                aria-label={tr('标注详情')}
              >
                <blockquote className="max-h-32 overflow-auto border-l-2 border-line pl-2 text-caption text-fg-muted whitespace-pre-wrap wrap-anywhere">
                  {active.quote}
                </blockquote>
                <p className="text-caption text-fg-muted">
                  {tr('创建：{name} · 最近修改：{name2}', {
                    name: trServer(active.createdBy.name),
                    name2: trServer(active.updatedBy.name),
                  })}
                </p>
                {active.publishedFrom && (
                  <p className="text-caption text-fg-muted">
                    {tr(
                      '来源：{name} 的个人标注第{value}{sourceVersion} 版，由{value2}{name2} 发布。',
                      {
                        name: trServer(active.publishedFrom.author.name),
                        value: ' ',
                        sourceVersion: active.publishedFrom.sourceVersion,
                        value2: ' ',
                        name2: trServer(active.publishedFrom.publishedBy.name),
                      },
                    )}
                  </p>
                )}
                {(active.anchorStatus !== 'current' || active.fileId !== paper.fileId) && (
                  <p role="status" className="text-small text-warning">
                    {tr(
                      '原文版本不同／定位待确认。记录仍保留，暂不在当前 PDF 上显示，也不能发布。',
                    )}
                  </p>
                )}
                {active.deletedAt ? (
                  <div className="space-y-2">
                    <Badge>{tr('已删除')}</Badge>
                    <p className="text-caption text-fg-muted">
                      {tr('恢复会从最后保存的内容创建新标注。旧的离线编辑不会自动合入。')}
                    </p>
                    {writable && (
                      <Button
                        size="sm"
                        loading={busy}
                        onClick={() =>
                          void perform(async () => {
                            const restored = await annotationApi.restore(scope, active);
                            await refresh();
                            setShowDeleted(false);
                            onSelect(restored.id);
                          })
                        }
                      >
                        {active.restoredToId ? tr('打开已恢复的标注') : tr('恢复为新标注')}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={active.anchorStatus !== 'current' || active.fileId !== paper.fileId}
                      onClick={() => onJump(active)}
                    >
                      {tr('定位原文')}
                    </Button>
                    {writable && (
                      <>
                        {isPersonalLibrary(scope) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy}
                            onClick={() =>
                              void perform(async () => {
                                const latest = await annotationApi.flush(
                                  scope,
                                  paper.id,
                                  active.id,
                                );
                                await annotationApi.brief(scope, latest);
                                await qc.invalidateQueries({ queryKey: notesKey(scope, paper.id) });
                                toast({
                                  tone: 'success',
                                  title: tr('个人说明稿已创建'),
                                  description: tr('可在笔记中整理；发布前仅自己可见。'),
                                });
                                onOpenNotes?.();
                              })
                            }
                          >
                            {tr('制作说明稿')}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing({ row: active, color: active.color, label: active.label });
                            setError('');
                            setCurrent(null);
                          }}
                        >
                          {tr('修改颜色与说明')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () =>
                              setDeleting(await annotationApi.flush(scope, paper.id, active.id)),
                            )
                          }
                        >
                          {tr('删除标注')}
                        </Button>
                      </>
                    )}
                  </div>
                )}
                {active.kind === 'comment' && (
                  <AnnotationBodyEditor
                    key={active.id}
                    annotation={active}
                    scope={scope}
                    writable={writable}
                  />
                )}
              </section>
            )}
          </li>
        ))}
      </ul>
      {error && !editing && !deleting && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      {editing && (
        <Dialog
          open
          title={tr('修改颜色与说明')}
          onOpenChange={(open) => {
            if (!open && !busy) setEditing(null);
          }}
          footer={
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                void perform(async () => {
                  await annotationApi.update(scope, paper.id, editing.row.id, {
                    color: editing.color,
                    label: editing.label,
                    baseMetadataVersion: editing.row.metadataVersion,
                  });
                  await refresh();
                  setEditing(null);
                })
              }
            >
              {tr('保存修改')}
            </Button>
          }
        >
          <div className="space-y-3">
            <Select
              aria-label={tr('新的标注颜色')}
              value={editing.color}
              onChange={(e) => setEditing({ ...editing, color: e.target.value as AnnotationColor })}
            >
              {Object.entries(ANNOTATION_COLORS).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </Select>
            <Input
              aria-label={tr('新的标注说明')}
              value={editing.label}
              maxLength={160}
              onChange={(e) => setEditing({ ...editing, label: e.target.value })}
            />
            {error && (
              <p role="alert" className="text-small text-danger">
                {error}
              </p>
            )}
            {current && (
              <div className="space-y-2 text-small">
                <p>
                  {tr('服务器最新内容：')}
                  {ANNOTATION_COLORS[current.color]} · {current.label || tr('无说明')}
                  {tr('。你的草稿仍在上方。')}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditing({ ...editing, row: current });
                    setCurrent(null);
                    setError('');
                  }}
                >
                  {tr('已核对，保留草稿继续修改')}
                </Button>
              </div>
            )}
          </div>
        </Dialog>
      )}
      {deleting && (
        <Dialog
          open
          title={tr('删除这条标注？')}
          description={tr(
            '将停止这条批注的共同编辑。已保存内容可从“查看已删除”恢复；个人与团队的另一份副本不受影响。',
          )}
          onOpenChange={(open) => {
            if (!open && !busy) setDeleting(null);
          }}
          footer={
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                void perform(async () => {
                  await annotationApi.trash(scope, deleting);
                  await refresh();
                  setDeleting(null);
                })
              }
            >
              {tr('确认删除标注')}
            </Button>
          }
        >
          <p className="text-small whitespace-pre-wrap wrap-anywhere">
            {deleting.body || deleting.quote}
          </p>
          {error && (
            <p role="alert" className="mt-2 text-small text-danger">
              {error}
            </p>
          )}
          {current && (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => {
                setDeleting(current);
                setCurrent(null);
                setError('');
              }}
            >
              {tr('重新核对最新内容')}
            </Button>
          )}
        </Dialog>
      )}
    </div>
  );
}
