import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LIBRARY_TRANSLATION_MAX_CHARS,
  TRANSLATION_LANGUAGES,
  type LibraryTranslationResult,
  type TranslationLanguage,
} from '@srh/shared';
import { Button, Select, Spinner, Switch, toast } from '@/components/ui';
import { translatePaperSelection, useTranslationModels } from '../api';
import { isPersonalLibrary, type LibraryScope } from '../lib/scope';
import type { PdfTextSelection } from './selection';
import { tr } from '@/lib/i18n';

interface Props {
  scope: LibraryScope;
  paperId: string;
  fileId: string;
  selection: PdfTextSelection | null;
  writable: boolean;
  onClear: () => void;
}

/** 常驻侧栏：只保留本次阅读的快照，不把原文或译文写入本地存储/团队。 */
export function SelectionTranslation({
  scope,
  paperId,
  fileId,
  selection,
  writable,
  onClear,
}: Props) {
  const models = useTranslationModels(scope, writable);
  const [automatic, setAutomatic] = useState(true);
  const [language, setLanguage] = useState<TranslationLanguage>('zh-CN');
  const [chosenModel, setChosenModel] = useState('');
  const [outcome, setOutcome] = useState<{
    key: string;
    pending: boolean;
    result: LibraryTranslationResult | null;
    error: string | null;
  } | null>(null);
  const request = useRef<{
    id: number;
    controller?: AbortController;
    timer?: ReturnType<typeof setTimeout>;
  }>({ id: 0 });
  const modelId = chosenModel || models.data?.defaultModel || '';
  // 首次目录加载后固定这个选择；目录刷新/权限撤销时不能悄悄换提供方发送原文。
  if (!chosenModel && modelId) setChosenModel(modelId);
  const model = models.data?.models.find((m) => m.id === modelId);
  const text = selection?.text ?? '';
  const page = selection?.page ?? 0;
  const tooLong = text.length > LIBRARY_TRANSLATION_MAX_CHARS;
  const allowed = writable && !!model && !!text && !tooLong;
  const scopeId = isPersonalLibrary(scope) ? scope.userId : scope;
  const personal = isPersonalLibrary(scope);
  const key = JSON.stringify([personal, scopeId, paperId, fileId, text, page, modelId, language]);
  const current = outcome?.key === key ? outcome : null;
  const result = current?.result ?? null;
  const error = current?.error ?? null;
  const pending = allowed && (current?.pending ?? false);

  const abort = useCallback(() => {
    request.current.id++;
    clearTimeout(request.current.timer);
    request.current.controller?.abort();
  }, []);

  const run = useCallback(async () => {
    if (!allowed) return;
    abort();
    const controller = new AbortController();
    const id = request.current.id;
    request.current.controller = controller;
    setOutcome({ key, pending: true, error: null, result: null });
    try {
      const translated = await translatePaperSelection(
        personal ? { kind: 'personal', userId: scopeId } : scopeId,
        paperId,
        { text, page, fileId, targetLanguage: language, modelId },
        controller.signal,
      );
      if (id === request.current.id && !controller.signal.aborted)
        setOutcome({ key, pending: false, error: null, result: translated });
    } catch (err) {
      if (id === request.current.id && !controller.signal.aborted)
        setOutcome({
          key,
          pending: false,
          result: null,
          error: err instanceof Error ? err.message : tr('翻译失败，请重试'),
        });
    }
  }, [allowed, abort, personal, scopeId, paperId, text, page, fileId, language, modelId, key]);

  useEffect(() => {
    abort();
    if (automatic && allowed) request.current.timer = setTimeout(() => void run(), 500);
    return abort;
  }, [automatic, allowed, run, abort]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ tone: 'success', title: tr('已复制') });
    } catch {
      toast({ tone: 'warning', title: tr('无法自动复制，请选中文字后按 Ctrl+C') });
    }
  };

  return (
    <div data-library-selection-tools className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-small font-medium">{tr('选区翻译')}</span>
        <label className="flex items-center gap-2 text-small">
          {tr('自动翻译')}
          <Switch
            label={tr('自动翻译')}
            checked={automatic}
            disabled={!writable}
            onCheckedChange={(value) => {
              abort();
              setOutcome((previous) => (previous?.pending ? null : previous));
              setAutomatic(value);
            }}
          />
        </label>
      </div>
      <p className="text-caption text-fg-muted">
        {automatic
          ? tr('选好文字后自动翻译，会消耗所选模型额度。')
          : tr('选好文字后，点击“开始翻译”。')}
        {tr('只发送选中的原文，译文不会自动保存或发布到团队。')}
      </p>
      <div className="grid grid-cols-1 gap-3">
        <label className="space-y-1 text-small text-fg-muted">
          {tr('翻译模型')}
          <Select
            aria-label={tr('翻译模型')}
            value={modelId}
            disabled={!writable || !models.data?.models.length}
            onChange={(e) => setChosenModel(e.target.value)}
          >
            {!models.data?.models.length && (
              <option value="">
                {models.isPending && writable ? tr('正在读取模型…') : tr('尚无可用模型')}
              </option>
            )}
            {chosenModel && !model && (
              <option value={chosenModel}>{tr('原模型已不可用，请重新选择')}</option>
            )}
            {models.data?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.providerName} / {m.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1 text-small text-fg-muted">
          {tr('目标语言')}
          <Select
            aria-label={tr('目标语言')}
            value={language}
            onChange={(e) => setLanguage(e.target.value as TranslationLanguage)}
          >
            {Object.entries(TRANSLATION_LANGUAGES).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {writable && (
        <Button variant="ghost" size="sm" onClick={() => void models.refetch()}>
          {tr('刷新模型列表')}
        </Button>
      )}
      {!writable && (
        <p className="text-small text-fg-muted">
          {tr('项目访客可复制文字；调用模型翻译需要项目写入权限。')}
        </p>
      )}
      {models.isError && (
        <p role="alert" className="text-small text-danger">
          {tr('无法读取模型列表：{message}', { message: models.error.message })}
        </p>
      )}
      {writable && models.isSuccess && !models.data.models.length && (
        <p role="status" className="text-small text-fg-muted">
          {tr(
            '尚未配置可用模型。个人库可使用平台模型，以及你有写入权限的项目模型。请在对应项目的“设置 → 模型”配置，再刷新模型列表。',
          )}
        </p>
      )}
      {model && (
        <p className="text-caption text-fg-muted">
          {tr('本次发送给：{providerName} / {name}', {
            providerName: model.providerName,
            name: model.name,
          })}
        </p>
      )}
      {!selection ? (
        <p className="text-small text-fg-muted">
          {tr('在 PDF 中划选一个词或一句话，原文和译文会显示在这里。一次选择同一页内的文字。')}
        </p>
      ) : (
        <>
          <div>
            <p className="mb-1 text-caption text-fg-muted">
              {tr('原文 · 第 {page} 页 · {count} 字符', { page, count: text.length })}
            </p>
            <p
              aria-label={tr('翻译原文')}
              className="max-h-40 overflow-auto rounded-md bg-subtle p-3 text-small whitespace-pre-wrap wrap-anywhere"
            >
              {text}
            </p>
          </div>
          {selection.warning && (
            <p role="status" className="text-small text-warning">
              {selection.warning}
            </p>
          )}
          {tooLong && (
            <p className="text-small text-warning">
              {tr('一次最多翻译 {LIBRARY_TRANSLATION_MAX_CHARS} 字符，请缩短选区。', {
                LIBRARY_TRANSLATION_MAX_CHARS,
              })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {pending ? (
              <Button
                variant="secondary"
                onClick={() => {
                  abort();
                  setOutcome(null);
                }}
              >
                {tr('取消翻译')}
              </Button>
            ) : (
              <Button variant="primary" disabled={!allowed} onClick={() => void run()}>
                {error ? tr('重试翻译') : result ? tr('重新翻译') : tr('开始翻译')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => void copy(text)}>
              {tr('复制原文')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                abort();
                onClear();
              }}
            >
              {tr('清除选区')}
            </Button>
          </div>
        </>
      )}
      {pending && (
        <div role="status" className="flex items-center gap-2 text-small text-fg-muted">
          <Spinner />
          {tr('正在翻译，可随时取消…')}
        </div>
      )}
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      {result && (
        <div>
          <p className="mb-1 text-caption text-fg-muted">
            {tr('译文 · {value}', { value: TRANSLATION_LANGUAGES[result.targetLanguage] })}
          </p>
          <p
            aria-label={tr('译文')}
            className="rounded-md border border-line bg-surface p-3 text-body whitespace-pre-wrap wrap-anywhere"
          >
            {result.translation}
          </p>
          <Button
            className="mt-2"
            variant="secondary"
            onClick={() => void copy(result.translation)}
          >
            {tr('复制译文')}
          </Button>
          <p className="mt-2 text-caption text-fg-subtle">
            {tr('模型：{modelName}。专业术语与公式请对照原文核对。', {
              modelName: result.modelName,
            })}
          </p>
        </div>
      )}
    </div>
  );
}
