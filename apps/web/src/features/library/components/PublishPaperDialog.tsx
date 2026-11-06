import { useState } from 'react';
import { Link } from 'react-router';
import type {
  Paper,
  PaperNote,
  PaperQaPublishSelection,
  PaperPublicationTarget,
} from '@srh/shared';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, Select } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { useMe } from '@/lib/session';
import { usePublishPaper } from '../api';
import type { PersonalLibrary } from '../lib/scope';
import { isWorking, shortAuthors, sourceLine } from '../lib/format';
import { noteApi, usePaperNotes } from '../notes-api';
import { AnnotationPublicationPicker } from './AnnotationPublicationPicker';
import { QaPublicationPicker } from './QaPublicationPicker';
import { tr } from '@/lib/i18n';

/** 每次打开创建一次请求编号；失败重试沿用它，改目标项目时才换编号。 */
export function PublishPaperDialog({
  scope,
  paper,
  onClose,
}: {
  scope: PersonalLibrary;
  paper: Paper;
  onClose: () => void;
}) {
  const me = useMe();
  const [snapshot] = useState(paper);
  const [projectId, setProjectId] = useState('');
  const [targetId, setTargetId] = useState('');
  const targets = useQuery({
    queryKey: ['publication-targets', scope.userId, paper.id, projectId],
    enabled: Boolean(projectId),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      api.get<PaperPublicationTarget<Paper>[]>(`/library/papers/${paper.id}/publish-targets`, {
        query: { projectId },
        signal,
      }),
  });
  const target = targets.data?.find((t) => t.paper.id === targetId);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const publish = usePublishPaper(scope, paper.id);
  const [chooseNotes, setChooseNotes] = useState(false);
  const notes = usePaperNotes(scope, paper.id, chooseNotes);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<PaperNote[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [annotationSelection, setAnnotationSelection] = useState<
    { id: string; version: number }[] | null
  >([]);
  const [qaSelection, setQaSelection] = useState<PaperQaPublishSelection[] | null>([]);
  const projects = (me.data?.projects ?? []).filter((p) => !p.archivedAt && p.role !== 'guest');
  const blocked = isWorking(snapshot.status) || Boolean(snapshot.archivedAt);
  const existing =
    publish.error instanceof ApiRequestError ? publish.error.details?.existingPaperId : undefined;
  const result = publish.data;
  const selections = {
    notes: preview ?? [],
    annotations: annotationSelection ?? [],
    qa: qaSelection ?? [],
  };
  const counts = (['notes', 'annotations', 'qa'] as const).map((kind) => {
    const skipped = selections[kind].filter((r) =>
      target?.published[kind].some((p) => p.id === r.id && p.version === r.version),
    ).length;
    return {
      kind,
      label: { notes: tr('笔记'), annotations: tr('标注'), qa: tr('问答') }[kind],
      added: selections[kind].length - skipped,
      skipped,
    };
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !publish.isPending) onClose();
      }}
      title={tr('发布论文到项目')}
      size="md"
      description={tr('项目会得到独立副本。之后修改或删除个人原件，不影响已经发布的项目资料。')}
      footer={
        <>
          <Button variant="ghost" disabled={publish.isPending} onClick={onClose}>
            {result ? tr('完成') : tr('取消')}
          </Button>
          {!result && (
            <Button
              variant="primary"
              loading={publish.isPending}
              disabled={
                !projectId ||
                targets.isPending ||
                targets.isFetching ||
                targets.isError ||
                Boolean(targets.data?.length && !target) ||
                Boolean(
                  target &&
                  (!counts.some((c) => c.added + c.skipped) ||
                    target.paper.archivedAt ||
                    (!target.samePdf && counts[1]!.added)),
                ) ||
                blocked ||
                me.isPending ||
                me.isError ||
                previewing ||
                annotationSelection === null ||
                qaSelection === null ||
                (selected.length > 0 && !preview)
              }
              onClick={() =>
                publish.mutate({
                  projectId,
                  requestId,
                  sourceUpdatedAt: snapshot.updatedAt,
                  ...(target
                    ? { targetPaperId: target.paper.id, targetUpdatedAt: target.paper.updatedAt }
                    : {}),
                  ...(annotationSelection?.length ? { annotations: annotationSelection } : {}),
                  ...(qaSelection?.length ? { qa: qaSelection } : {}),
                  ...(preview?.length
                    ? { notes: preview.map((n) => ({ id: n.id, version: n.version })) }
                    : {}),
                })
              }
            >
              {publish.error ? tr('重试发布') : target ? tr('确认追加') : tr('确认发布')}
            </Button>
          )}
        </>
      }
    >
      {result ? (
        <div role="status" className="space-y-3 text-small">
          <p>
            {result.replayed
              ? tr('这次发布已完成，已找到之前创建的项目副本。')
              : tr('发布成功，项目成员可以看到这篇论文。')}
          </p>
          {result.summary && (
            <p>
              {tr(
                '本次新增：笔记 {notes}、标注 {annotations}、问答 {qa}；跳过已发布版本{value}{value2}{value3}条。团队原有内容保留。',
                {
                  notes: result.summary.added.notes,
                  annotations: result.summary.added.annotations,
                  qa: result.summary.added.qa,
                  value: ' ',
                  value2: Object.values(result.summary.skipped).reduce((a, b) => a + b, 0),
                  value3: ' ',
                },
              )}
            </p>
          )}
          <Link
            className="inline-flex min-h-11 items-center text-accent-text hover:underline"
            to={`/p/${result.paper.projectId}/library/${result.paper.id}`}
          >
            {tr('打开项目副本')}
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="block space-y-1 text-small">
            <span>{tr('目标项目')}</span>
            <Select
              aria-label={tr('目标项目')}
              value={projectId}
              disabled={publish.isPending || me.isPending}
              onChange={(e) => {
                setProjectId(e.target.value);
                setTargetId('');
                setQaSelection([]);
                setRequestId(crypto.randomUUID());
                publish.reset();
              }}
            >
              <option value="">{tr('请选择项目')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          {projectId && (
            <section className="space-y-2 text-small" aria-label={tr('追加目标')}>
              {targets.isFetching && <p role="status">{tr('正在核对项目已有论文…')}</p>}
              {targets.error && <p role="alert">{targets.error.message}</p>}
              {!!targets.data?.length && (
                <>
                  <label className="block">
                    {tr('项目已有同论文候选，请核对后选择')}
                    <Select
                      aria-label={tr('追加到项目论文')}
                      value={targetId}
                      disabled={publish.isPending}
                      onChange={(e) => {
                        setTargetId(e.target.value);
                        setQaSelection([]);
                        setRequestId(crypto.randomUUID());
                        publish.reset();
                      }}
                    >
                      <option value="">{tr('请选择追加目标')}</option>
                      {targets.data.map((t) => (
                        <option
                          key={t.paper.id}
                          value={t.paper.id}
                          disabled={Boolean(t.paper.archivedAt)}
                        >
                          {t.paper.title}
                          {t.paper.archivedAt ? tr('（已归档，请先恢复）') : ''}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {target && (
                    <>
                      <p>{target.reasons.join(tr('；'))}</p>
                      <p className={target.samePdf ? 'text-fg-muted' : 'text-warning'}>
                        {target.samePdf
                          ? tr('PDF 内容一致，可以追加所选记录。')
                          : tr(
                              'PDF 版本不同或无法核对：不能追加高亮和批注；问答中的原文定位将逐条核对。',
                            )}
                      </p>
                      <p>
                        {tr(
                          '保留项目标题、PDF 和已有正文。已发布过的同一版本会跳过；个人更新的版本作为新记录追加，不覆盖团队修改。已删除的团队记录也不会因重复发布自动恢复。',
                        )}
                      </p>
                    </>
                  )}
                </>
              )}
              {targets.isSuccess && !targets.data.length && (
                <p>{tr('没有发现同论文候选，将新建项目副本。')}</p>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={publish.isPending || targets.isFetching}
                onClick={() => {
                  setTargetId('');
                  setQaSelection([]);
                  setRequestId(crypto.randomUUID());
                  publish.reset();
                  void targets.refetch();
                }}
              >
                {tr('重新核对项目论文')}
              </Button>
            </section>
          )}
          {me.isPending && (
            <p role="status" className="text-small text-fg-muted">
              {tr('正在读取项目…')}
            </p>
          )}
          {me.isError && (
            <p role="alert" className="text-small text-danger">
              {tr('项目列表读取失败。')}
              <Button variant="ghost" size="sm" onClick={() => void me.refetch()}>
                {tr('重试')}
              </Button>
            </p>
          )}
          {me.isSuccess && projects.length === 0 && (
            <p className="text-small text-fg-muted">
              {tr('暂无可发布的项目。请先加入项目并取得写入权限，或')}
              <Link to="/new" className="text-accent-text underline">
                {tr('新建课题')}
              </Link>
              {tr('。')}
            </p>
          )}
          <div className="rounded-md border border-line bg-surface p-3 text-small space-y-2">
            <p className="font-medium wrap-anywhere">{snapshot.title}</p>
            <p className="text-fg-muted">
              {shortAuthors(snapshot.authors)} · {sourceLine(snapshot) || tr('暂无出版信息')}
            </p>
            <p>
              {target
                ? tr('保留项目已有 PDF，不复制或替换文件')
                : snapshot.fileId
                  ? tr('包含独立的 PDF 副本')
                  : tr('仅论文信息：当前没有 PDF，发布后可在项目库补传')}
            </p>
            <p>
              {target
                ? tr('保留项目已有标题、标签和解析结果。')
                : tr('包含已有解析结果（{chunkCount} 个段落）和论文标签。', {
                    chunkCount: snapshot.chunkCount,
                  })}
            </p>
            {snapshot.tags.length > 0 && (
              <p className="wrap-anywhere">
                {tr('标签：')}
                {snapshot.tags.join(tr('、'))}
              </p>
            )}
          </div>
          <p className="text-small text-fg-muted">
            {tr(
              '默认不包含私人阅读记录。可以分别选择笔记、团队说明稿、高亮、批注和问答；临时译文不包含。追加时不复制论文信息或 PDF。',
            )}
          </p>
          {!chooseNotes && (
            <Button
              variant="secondary"
              disabled={publish.isPending}
              onClick={() => setChooseNotes(true)}
            >
              {tr('选择要发布的笔记')}
            </Button>
          )}
          {chooseNotes && (
            <section className="space-y-3">
              <p className="text-small font-medium">{tr('只发布勾选的笔记（默认全不选）')}</p>
              {notes.isPending && <p role="status">{tr('正在读取笔记…')}</p>}
              {notes.error && (
                <p role="alert">
                  {notes.error.message}
                  <Button onClick={() => void notes.refetch()}>{tr('重试')}</Button>
                </p>
              )}
              {notes.data?.length === 0 && (
                <p className="text-small text-fg-muted">
                  {tr('暂无独立笔记。旧版笔记需先在阅读页复制为独立笔记。')}
                </p>
              )}
              {notes.data?.map((n) => (
                <label
                  key={n.id}
                  className="flex min-h-11 items-center gap-2 text-small wrap-anywhere"
                >
                  <input
                    type="checkbox"
                    disabled={publish.isPending || previewing}
                    checked={selected.includes(n.id)}
                    onChange={(e) => {
                      setSelected(
                        e.target.checked
                          ? [...selected, n.id]
                          : selected.filter((id) => id !== n.id),
                      );
                      setPreview(null);
                      setRequestId(crypto.randomUUID());
                      publish.reset();
                    }}
                  />
                  {n.kind === 'brief' ? tr('说明稿 · ') : ''}
                  {n.title}
                </label>
              ))}
              {selected.length > 0 && (
                <Button
                  variant="secondary"
                  loading={previewing}
                  disabled={publish.isPending}
                  onClick={async () => {
                    setPreviewing(true);
                    setPreview(null);
                    setPreviewError('');
                    publish.reset();
                    try {
                      const rows = await Promise.all(
                        selected.map((id) => noteApi.flush(scope, paper.id, id)),
                      );
                      setPreview(rows);
                      setRequestId(crypto.randomUUID());
                    } catch (e) {
                      setPreviewError((e as Error).message);
                    } finally {
                      setPreviewing(false);
                    }
                  }}
                >
                  {preview ? tr('重新预览所选正文') : tr('预览所选正文')}
                </Button>
              )}
              {previewError && (
                <p role="alert" className="text-small text-danger">
                  {previewError}
                </p>
              )}
              {preview && (
                <div className="space-y-3 rounded-md border border-line p-3">
                  <p className="text-small font-medium">
                    {tr('以下全文将对项目成员可见，请检查后确认发布。')}
                  </p>
                  {preview.map((n) => (
                    <article key={n.id}>
                      <h3 className="text-small font-medium wrap-anywhere">{n.title}</h3>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere text-small font-sans">
                        {n.body || tr('（空白正文）')}
                      </pre>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          <AnnotationPublicationPicker
            scope={scope}
            paperId={paper.id}
            disabled={publish.isPending}
            onChange={(selection) => {
              setAnnotationSelection(selection);
              setRequestId(crypto.randomUUID());
              publish.reset();
            }}
          />
          <QaPublicationPicker
            key={`${projectId}:${targetId}`}
            scope={scope}
            paperId={paper.id}
            projectId={projectId}
            targetPaperId={targetId || undefined}
            disabled={publish.isPending}
            onChange={(s) => {
              setQaSelection(s);
              setRequestId(crypto.randomUUID());
              publish.reset();
            }}
          />
          {target && (
            <p className="text-small" role="status">
              {tr('本次选择：')}
              {counts
                .map((c) =>
                  tr('{label}新增 {added}、跳过 {skipped}', {
                    label: c.label,
                    added: c.added,
                    skipped: c.skipped,
                  }),
                )
                .join(tr('；'))}
              {tr('。请核对上方正文后确认追加。')}
            </p>
          )}
          {blocked && (
            <p role="status" className="text-small text-warning">
              {snapshot.archivedAt
                ? tr('请先恢复已归档论文。')
                : tr('论文正在处理，请等完成后重新打开发布窗口。')}
            </p>
          )}
          {publish.error && (
            <div role="alert" className="text-small text-danger space-y-2">
              <p>{publish.error.message}</p>
              {typeof existing === 'string' && (
                <Link
                  className="inline-flex min-h-11 items-center text-accent-text underline"
                  to={`/p/${projectId}/library/${existing}`}
                >
                  {tr('查看项目已有论文')}
                </Link>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
