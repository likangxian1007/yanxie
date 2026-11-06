import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { CitationMarker, PaperQaTurn, PaperQaStatus, PaperQaAskInput } from '@srh/shared';
import { Button, Dialog, Input, Select, Textarea } from '@/components/ui';
import { useTranslationModels } from '../api';
import { useReader } from '../lib/reader';
import { libraryPath, isPersonalLibrary, type LibraryScope } from '../lib/scope';
import { qaApi, qaActive, qaKey, useQaSessions, useQaTurns } from '../qa-api';
import { notesKey } from '../notes-api';
import { RichAnswer, type ResolvedCite } from './RichAnswer';
import { QaTurnEditor, QaHistory } from './QaTurnEditor';
import { tr, trServer } from '@/lib/i18n';
const labels: Record<PaperQaStatus, string> = {
  queued: tr('已保存，等待生成'),
  retrieving: tr('正在检索'),
  generating: tr('正在生成'),
  done: tr('已完成'),
  failed: tr('未完成'),
  cancelled: tr('已停止'),
  interrupted: tr('已中断'),
};
export function QaPanel({
  pid,
  llm,
  selection,
  onClearSelection,
}: {
  pid: LibraryScope;
  llm: boolean;
  selection?: PaperQaAskInput['selection'] | null;
  onClearSelection?: (selection: NonNullable<PaperQaAskInput['selection']>) => void;
}) {
  const { paper, writable, editable, jump } = useReader(),
    navigate = useNavigate(),
    qc = useQueryClient();
  const sessions = useQaSessions(pid, paper.id),
    [selected, setSelected] = useState('');
  const active =
    sessions.data?.find((s) => s.id === selected) ?? (selected ? undefined : sessions.data?.[0]);
  const turns = useQaTurns(pid, paper.id, active?.id ?? ''),
    models = useTranslationModels(pid, writable);
  const [input, setInput] = useState(''),
    [whole, setWhole] = useState(false),
    [useContext, setUseContext] = useState(true),
    [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [form, setForm] = useState<{ kind: 'new' | 'rename' | 'delete'; title: string } | null>(
    null,
  );
  const retry = useRef<{ signature: string; requestId: string } | null>(null);
  const context = (turns.data ?? []).filter((t) => t.status === 'done').slice(-3);
  const refresh = () => qc.invalidateQueries({ queryKey: qaKey(pid, paper.id) });
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const canAsk =
    writable &&
    !paper.archivedAt &&
    (models.data ? models.data.models.length > 0 : llm) &&
    (whole || paper.status === 'ready' || Boolean(selection)) &&
    (!selection || selection.fileId === paper.fileId);
  const ask = () =>
    perform(async () => {
      const question = input.trim();
      if (!question || !canAsk) return;
      let session = active;
      if (!session) {
        session = await qaApi.create(pid, paper.id, tr('论文问答'));
        setSelected(session.id);
      }
      const body: Omit<PaperQaAskInput, 'requestId'> = {
        question,
        searchScope: whole ? 'all' : 'paper',
        contextTurnIds: useContext ? context.map((t) => t.id) : [],
        ...(modelId ? { modelId } : {}),
        ...(selection ? { selection } : {}),
      };
      const signature = JSON.stringify({ sessionId: session.id, ...body });
      if (retry.current?.signature !== signature)
        retry.current = { signature, requestId: crypto.randomUUID() };
      await qaApi.ask(pid, paper.id, session.id, { ...body, requestId: retry.current!.requestId });
      setInput('');
      if (selection) onClearSelection?.(selection);
      retry.current = null;
    });
  const resolve =
    (turn: PaperQaTurn) =>
    (m: CitationMarker): ResolvedCite => {
      const label = `${m.citekey ? `${m.citekey} ` : ''}p.${m.page}${m.para ? ` ¶${m.para}` : ''}`;
      const s = turn.sources.find(
        (s) =>
          (!m.citekey || s.citekey === m.citekey) &&
          s.page === m.page &&
          (m.para === null || s.para === m.para),
      );
      if (!s || s.status !== 'available' || !s.paperId)
        return {
          label,
          onOpen: null,
          title:
            s?.status === 'unshared'
              ? tr('来源未共享')
              : s?.status === 'changed'
                ? tr('原 PDF 已变更，定位待复核')
                : s?.status === 'missing'
                  ? tr('来源已删除或无权访问')
                  : tr('没有可核实的来源'),
        };
      return {
        label,
        title: tr('打开《{paperTitle}》第 {page} 页', { paperTitle: s.paperTitle, page: s.page }),
        onOpen: () =>
          s.paperId === paper.id
            ? jump(s.page, s.boxes)
            : navigate(`${libraryPath(pid, s.paperId!)}?seq=${s.seq}`),
      };
    };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <Select
          aria-label={tr('问答会话')}
          value={active?.id ?? ''}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="" disabled>
            {tr('选择问答会话')}
          </option>
          {sessions.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </Select>
        {editable && !paper.archivedAt && (
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => setForm({ kind: 'new', title: '' })}
            >
              {tr('新建会话')}
            </Button>
            {active && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setForm({ kind: 'rename', title: active.title })}
                >
                  {tr('重命名')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setForm({ kind: 'delete', title: active.title })}
                >
                  {tr('删除会话')}
                </Button>
              </>
            )}
          </div>
        )}
        <p className="text-caption text-fg-muted">
          {isPersonalLibrary(pid)
            ? tr('个人问答仅自己可见，发布时再选择。')
            : tr('项目成员共享问答，已完成的正文可共同编辑。')}
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {sessions.isPending && <p role="status">{tr('正在读取会话…')}</p>}
        {(sessions.error || turns.error) && (
          <div role="alert">
            <p>{(sessions.error || turns.error)?.message}</p>
            <Button onClick={() => void refresh()}>{tr('重试读取')}</Button>
          </div>
        )}
        {active && turns.isPending && <p role="status">{tr('正在读取问答…')}</p>}
        {(!active || turns.data?.length === 0) && (
          <p className="text-small text-fg-muted">
            {tr('提交第一个问题后，问题、回答和引用会自动保存。')}
          </p>
        )}
        {turns.data?.map((t) => (
          <TurnCard
            key={t.id}
            turn={t}
            scope={pid}
            editable={editable && !paper.archivedAt}
            resolve={resolve(t)}
            onStop={() =>
              perform(async () => {
                await qaApi.stop(pid, paper.id, t.id);
              })
            }
            onRetry={() => setInput(t.originalQuestion)}
            onBrief={() =>
              perform(async () => {
                const latest = await qaApi.flush(pid, paper.id, t.id);
                await qaApi.brief(pid, paper.id, latest);
                await qc.invalidateQueries({ queryKey: notesKey(pid, paper.id) });
                setNotice(tr('已创建个人团队说明稿，请到“笔记”栏目整理后再选择发布。'));
              })
            }
          />
        ))}
      </div>
      <form
        className="shrink-0 space-y-2 border-t border-line bg-surface p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void ask();
        }}
      >
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-small text-success">
            {notice}
          </p>
        )}
        {selection && (
          <div
            className="space-y-1 rounded-md border border-line p-2 text-small"
            aria-label={tr('待发送的原文引用')}
          >
            <p>
              {tr('引用原文 · 第 {page} 页（发送问题时一起交给模型）', { page: selection.page })}
            </p>
            <blockquote className="max-h-24 overflow-auto whitespace-pre-wrap wrap-anywhere">
              {selection.text}
            </blockquote>
            {selection.fileId !== paper.fileId && (
              <p role="alert">{tr('PDF 已变化，请移除此引用后重新选择。')}</p>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onClearSelection?.(selection)}
            >
              {tr('移除引用')}
            </Button>
          </div>
        )}
        {!writable ? (
          <p className="text-small text-fg-muted">
            {tr('当前角色不能调用模型，仍可查看历史和共同维护已完成的正文。')}
          </p>
        ) : models.isError ? (
          <p role="alert" className="text-small text-danger">
            {models.error.message}
            <Button size="sm" onClick={() => void models.refetch()}>
              {tr('重试模型列表')}
            </Button>
          </p>
        ) : (
          !canAsk && (
            <p className="text-small text-fg-muted">
              {paper.archivedAt
                ? tr('论文已归档。')
                : selection && selection.fileId !== paper.fileId
                  ? tr('引用已过期，请重新选择。')
                  : paper.status !== 'ready' && !whole && !selection
                    ? tr('解析完成后可以提问。')
                    : tr('尚无可用模型，请在项目“设置 → 模型”配置。历史问答仍可阅读。')}
            </p>
          )
        )}
        {writable && (
          <>
            <Select
              aria-label={tr('问答模型')}
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
            >
              <option value="">{tr('默认可用模型')}</option>
              {models.data?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            <div className="flex flex-wrap gap-3 text-caption">
              <label className="flex min-h-8 items-center gap-1">
                <input
                  type="checkbox"
                  checked={whole}
                  onChange={(e) => setWhole(e.target.checked)}
                />
                {tr('检索整个当前文献库')}
              </label>
              <label className="flex min-h-8 items-center gap-1">
                <input
                  type="checkbox"
                  checked={useContext}
                  onChange={(e) => setUseContext(e.target.checked)}
                />
                {tr('携带最近 ')}
                {context.length}
                {tr(' 条已完成问答')}
              </label>
            </div>
            {useContext && context.length > 0 && (
              <details className="text-caption text-fg-muted">
                <summary>{tr('查看将使用的上下文')}</summary>
                {context.map((t) => (
                  <p key={t.id} className="wrap-anywhere">
                    v{t.version} · {t.question}
                  </p>
                ))}
              </details>
            )}
            <Textarea
              aria-label={tr('问题')}
              placeholder={tr('输入问题，发送后自动保存')}
              rows={2}
              maxLength={2000}
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  !busy &&
                  canAsk
                ) {
                  e.preventDefault();
                  void ask();
                }
              }}
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!input.trim() || !canAsk}
            >
              {tr('发送问题')}
            </Button>
          </>
        )}
      </form>
      {form && (
        <Dialog
          open
          title={
            form.kind === 'delete'
              ? tr('删除这组问答？')
              : form.kind === 'new'
                ? tr('新建问答会话')
                : tr('重命名会话')
          }
          onOpenChange={(o) => {
            if (!o && !busy) setForm(null);
          }}
          footer={
            <Button
              variant={form.kind === 'delete' ? 'danger' : 'primary'}
              loading={busy}
              disabled={form.kind !== 'delete' && !form.title.trim()}
              onClick={() =>
                void perform(async () => {
                  if (form.kind === 'new') {
                    const s = await qaApi.create(pid, paper.id, form.title);
                    setSelected(s.id);
                  } else if (active && form.kind === 'rename')
                    await qaApi.rename(pid, paper.id, active, form.title);
                  else if (active) {
                    await qaApi.remove(pid, paper.id, active);
                    setSelected('');
                  }
                  setForm(null);
                })
              }
            >
              {form.kind === 'delete' ? tr('确认删除') : tr('保存会话')}
            </Button>
          }
        >
          {form.kind === 'delete' ? (
            <p className="text-small">
              {tr('这组问答将从当前文献库移除，正在生成的任务停止，已发布的独立副本不受影响。')}
            </p>
          ) : (
            <Input
              aria-label={tr('会话名称')}
              maxLength={160}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          )}
          {error && <p role="alert">{error}</p>}
        </Dialog>
      )}
    </div>
  );
}
function TurnCard({
  turn,
  scope,
  editable,
  resolve,
  onStop,
  onRetry,
  onBrief,
}: {
  turn: PaperQaTurn;
  scope: LibraryScope;
  editable: boolean;
  resolve: (m: CitationMarker) => ResolvedCite;
  onStop: () => Promise<void>;
  onRetry: () => void;
  onBrief: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false),
    [history, setHistory] = useState(false);
  const { paper, jump } = useReader();
  return (
    <article className="space-y-2 border-b border-line pb-4" data-qa-turn={turn.id}>
      <p className="whitespace-pre-wrap wrap-anywhere text-body font-medium">{turn.question}</p>
      {turn.selection && (
        <details className="text-small" open>
          <summary>{tr('提问时引用的原文 · 第 {page} 页', { page: turn.selection.page })}</summary>
          <blockquote className="max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere">
            {turn.selection.text}
          </blockquote>
          {turn.selection.status === 'available' && turn.selection.fileId === paper.fileId ? (
            <Button size="sm" variant="ghost" onClick={() => jump(turn.selection!.page)}>
              {tr('定位引用页')}
            </Button>
          ) : (
            <p className="text-warning">
              {tr('原文来源未共享、已删除或 PDF 版本变化；保留当时引用，不定位当前 PDF。')}
            </p>
          )}
        </details>
      )}
      <p className="text-caption text-fg-muted">
        {trServer(turn.createdBy.name)} · {labels[turn.status]} · {turn.modelName} · v{turn.version}
      </p>
      {turn.publishedFrom && (
        <p className="text-caption text-fg-muted">
          {tr('来源：{name} 的个人问答 v{sourceVersion}；由{value}{name2} 发布。', {
            name: trServer(turn.publishedFrom.author.name),
            sourceVersion: turn.publishedFrom.sourceVersion,
            value: ' ',
            name2: trServer(turn.publishedFrom.publishedBy.name),
          })}
        </p>
      )}
      {turn.contextOmitted && (
        <p className="text-caption text-warning">
          {tr('这条问答未共享全部历史上下文，使用结论前请核对。')}
        </p>
      )}
      {turn.answer && <RichAnswer text={turn.answer} resolve={resolve} />}
      {turn.error && (
        <p role="status" className="text-small text-warning">
          {turn.error}
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {qaActive(turn.status) && editable && (
          <Button size="sm" variant="secondary" onClick={() => void onStop()}>
            {tr('停止生成')}
          </Button>
        )}
        {!qaActive(turn.status) && turn.status !== 'done' && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {tr('重新提问')}
          </Button>
        )}
        {turn.status === 'done' && (
          <>
            <Button size="sm" variant="secondary" onClick={() => setEditing(!editing)}>
              {editing ? tr('收起编辑') : editable ? tr('编辑问答') : tr('查看正文')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setHistory(true)}>
              {tr('原始版本与历史')}
            </Button>
            {isPersonalLibrary(scope) && editable && (
              <Button size="sm" variant="ghost" onClick={() => void onBrief()}>
                {tr('制作说明稿')}
              </Button>
            )}
          </>
        )}
      </div>
      {editing && <QaTurnEditor scope={scope} turn={turn} editable={editable} />}
      {!!turn.sources.length && (
        <details className="text-small text-fg-muted">
          <summary>{tr('查看 {count} 条来源快照', { count: turn.sources.length })}</summary>
          {turn.sources.map((s) => (
            <div key={s.id} className="mt-2">
              <p>
                {s.paperTitle} · p.{s.page} ¶{s.para} ·{' '}
                {s.status === 'available'
                  ? tr('可定位')
                  : s.status === 'unshared'
                    ? tr('来源未共享')
                    : s.status === 'changed'
                      ? tr('PDF 已变更')
                      : tr('来源不可用')}
              </p>
              <p className="whitespace-pre-wrap wrap-anywhere">{s.quote}</p>
            </div>
          ))}
        </details>
      )}
      {!!turn.context.length && (
        <details className="text-caption text-fg-muted">
          <summary>{tr('生成时的上下文快照')}</summary>
          {turn.context.map((c) => (
            <div key={c.turnId}>
              <p>
                v{c.version} · {c.question}
              </p>
              <p className="whitespace-pre-wrap wrap-anywhere">{c.answer}</p>
            </div>
          ))}
        </details>
      )}
      {history && <QaHistory scope={scope} turn={turn} onClose={() => setHistory(false)} />}
    </article>
  );
}
