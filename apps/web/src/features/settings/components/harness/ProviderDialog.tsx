import { useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  EFFORT_LABEL,
  type LlmProvider,
  type ReasoningEffort,
  type ThinkingFormat,
} from '@srh/shared';
import { Button, Dialog, IconButton, Input, Select, toast } from '@/components/ui';
import { EFFORT_ORDER } from '@/features/harness';
import { useCreateProvider, useUpdateProvider } from '@/lib/harness';
import { errorMessage } from '../../lib';
import { Field, InlineError } from '../parts';
import { EffortToggles, SwitchRow } from './harness-parts';
import { THINKING_FORMAT_LABEL } from './perm';
import { tr } from '@/lib/i18n';

const FORMAT_HINT: Record<ThinkingFormat, string> = {
  deepseek: tr('发 thinking 与 reasoning_effort（DeepSeek 官方接口）；「中」按「高」发。'),
  openai: tr(
    '发 reasoning_effort（OpenAI 及多数兼容网关）；「不思考」时不发，「最高」按「高」发。',
  ),
  none: tr('不发任何推理参数，模型只有「不思考」一档。'),
  openrouter: tr('发 reasoning.effort（OpenRouter 统一推理参数）；「不思考」时不发。'),
};

const FORMAT_OPTIONS = (Object.keys(THINKING_FORMAT_LABEL) as ThinkingFormat[]).map((v) => ({
  value: v,
  label: THINKING_FORMAT_LABEL[v],
}));

interface ModelRow {
  model: string;
  name: string;
  description: string;
  efforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
}

function defaultEfforts(format: ThinkingFormat): Pick<ModelRow, 'efforts' | 'defaultEffort'> {
  if (format === 'none') return { efforts: ['off'], defaultEffort: 'off' };
  if (format === 'deepseek')
    return { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' };
  return { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };
}

function emptyRow(format: ThinkingFormat): ModelRow {
  return { model: '', name: '', description: '', ...defaultEfforts(format) };
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ProviderDialogProps {
  pid: string;
  /** null = 新建 */
  provider: LlmProvider | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 新建 / 编辑 OpenAI 兼容的模型接口。外层用 key 让表单在每次打开时重新初始化。 */
export function ProviderDialog({ pid, provider, open, onOpenChange }: ProviderDialogProps) {
  const ids = useId();
  const create = useCreateProvider(pid);
  const update = useUpdateProvider(pid);
  const save = provider ? update : create;
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [format, setFormat] = useState<ThinkingFormat>(provider?.thinkingFormat ?? 'openai');
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [rows, setRows] = useState<ModelRow[]>(
    provider?.models.map((m) => ({
      model: m.model,
      name: m.name === m.model ? '' : m.name,
      description: m.description ?? '',
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
    })) ?? [emptyRow('openai')],
  );
  const [touched, setTouched] = useState(false);

  const allowed: ReasoningEffort[] = format === 'none' ? ['off'] : EFFORT_ORDER;
  const nameError = name.trim() ? null : tr('请填写名称');
  const urlError = isHttpUrl(baseUrl)
    ? null
    : tr('请填写 http(s) 开头的接口地址，例如 https://api.example.com/v1');
  const rowsError = (() => {
    if (rows.length === 0) return tr('至少添加一个模型');
    const seen = new Set<string>();
    for (const r of rows) {
      const m = r.model.trim();
      if (!m) return tr('每个模型都要填模型 id');
      if (seen.has(m)) return tr('模型「{m}」重复了', { m });
      seen.add(m);
      if (format !== 'none' && r.efforts.length === 0)
        return tr('「{m}」至少要选一档推理强度', { m });
    }
    return null;
  })();

  const setRow = (i: number, patch: Partial<ModelRow>) =>
    setRows((list) =>
      list.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        if (!next.efforts.includes(next.defaultEffort) && next.efforts[0]) {
          next.defaultEffort = next.efforts.includes('high') ? 'high' : next.efforts[0];
        }
        return next;
      }),
    );

  const submit = () => {
    setTouched(true);
    if (nameError || urlError || rowsError) return;
    const models = rows.map((r) => {
      const efforts = format === 'none' ? (['off'] as ReasoningEffort[]) : r.efforts;
      return {
        model: r.model.trim(),
        ...(r.name.trim() ? { name: r.name.trim() } : {}),
        ...(r.description.trim() ? { description: r.description.trim() } : {}),
        efforts,
        defaultEffort: efforts.includes(r.defaultEffort) ? r.defaultEffort : (efforts[0] ?? 'off'),
      };
    });
    const body = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      thinkingFormat: format,
      models,
      enabled,
    };
    const onSuccess = (p: LlmProvider) => {
      toast.success(
        provider
          ? tr('已保存「{name}」', { name: p.name })
          : tr('已添加「{name}」', { name: p.name }),
        tr('可以点「测试连接」确认能连上。'),
      );
      onOpenChange(false);
    };
    if (provider) {
      const keyPatch = clearKey ? { apiKey: '' } : apiKey ? { apiKey } : {};
      update.mutate({ id: provider.id, patch: { ...body, ...keyPatch } }, { onSuccess });
    } else {
      create.mutate({ ...body, apiKey }, { onSuccess });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!save.isPending) onOpenChange(v);
      }}
      size="lg"
      title={provider ? tr('编辑「{name}」', { name: provider.name }) : tr('添加模型接口')}
      description={tr(
        '任何 OpenAI 兼容的 Chat Completions 接口都可以接入。API key 只保存在服务端，不会再显示出来。',
      )}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {provider ? tr('保存更改') : tr('添加接口')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr('名称')} htmlFor={`${ids}-name`}>
            <Input
              id={`${ids}-name`}
              data-autofocus
              value={name}
              maxLength={60}
              placeholder={tr('例如：实验室 vLLM')}
              error={touched && nameError ? nameError : undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={tr('推理参数格式')} htmlFor={`${ids}-format`} hint={FORMAT_HINT[format]}>
            <Select
              id={`${ids}-format`}
              value={format}
              options={FORMAT_OPTIONS}
              onChange={(e) => setFormat(e.target.value as ThinkingFormat)}
            />
          </Field>
        </div>

        <Field label={tr('接口地址（Base URL）')} htmlFor={`${ids}-url`}>
          <Input
            id={`${ids}-url`}
            value={baseUrl}
            maxLength={300}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://api.example.com/v1"
            className="font-mono"
            error={touched && urlError ? urlError : undefined}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>

        <Field
          label="API key"
          htmlFor={`${ids}-key`}
          hint={
            provider?.hasApiKey
              ? clearKey
                ? tr('保存后会清除已保存的 key。')
                : tr('已设置。留空则保持不变，填写则替换。')
              : tr('本地部署不需要 key 时可以留空。')
          }
        >
          <div className="flex items-center gap-2">
            <Input
              id={`${ids}-key`}
              type="password"
              value={apiKey}
              maxLength={400}
              disabled={clearKey}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={provider?.hasApiKey ? tr('已设置') : 'sk-…'}
              className="font-mono"
              onChange={(e) => setApiKey(e.target.value)}
            />
            {provider?.hasApiKey && (
              <Button
                size="sm"
                variant={clearKey ? 'subtle' : 'ghost'}
                aria-pressed={clearKey}
                onClick={() => {
                  setClearKey((v) => !v);
                  setApiKey('');
                }}
              >
                {clearKey ? tr('撤销清除') : tr('清除 key')}
              </Button>
            )}
          </div>
        </Field>

        <section aria-label={tr('模型')} className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-small font-medium text-fg">{tr('模型')}</h3>
            <span className="text-caption font-normal text-fg-subtle">
              {tr('模型 id 是发给接口的 model 字段')}
            </span>
          </div>
          <ul className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <li key={i} className="flex flex-col gap-2 rounded-md border border-line p-3">
                <div className="flex items-start gap-2">
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                    <Input
                      size="sm"
                      aria-label={tr('第 {value} 个模型的 id', { value: i + 1 })}
                      value={r.model}
                      maxLength={120}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={tr('模型 id，例如 qwen3-max')}
                      className="font-mono"
                      onChange={(e) => setRow(i, { model: e.target.value })}
                    />
                    <Input
                      size="sm"
                      aria-label={tr('第 {value} 个模型的显示名', { value: i + 1 })}
                      value={r.name}
                      maxLength={80}
                      placeholder={tr('显示名（选填）')}
                      onChange={(e) => setRow(i, { name: e.target.value })}
                    />
                    <Input
                      size="sm"
                      aria-label={tr('第 {value} 个模型的说明', { value: i + 1 })}
                      value={r.description}
                      maxLength={200}
                      placeholder={tr('一句话说明（选填），例如：长上下文，适合读论文')}
                      wrapperClassName="sm:col-span-2"
                      onChange={(e) => setRow(i, { description: e.target.value })}
                    />
                  </div>
                  <IconButton
                    label={tr('删除这个模型')}
                    size="sm"
                    disabled={rows.length <= 1}
                    onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
                  >
                    <Trash2 strokeWidth={1.75} aria-hidden />
                  </IconButton>
                </div>
                {format !== 'none' && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-caption text-fg-subtle">{tr('推理强度')}</span>
                      <EffortToggles
                        label={tr('第 {value} 个模型支持的推理强度', { value: i + 1 })}
                        value={r.efforts}
                        allowed={allowed}
                        onChange={(efforts) => setRow(i, { efforts })}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-caption text-fg-subtle">
                      {tr('默认')}
                      <Select
                        size="sm"
                        value={r.defaultEffort}
                        wrapperClassName="w-24"
                        disabled={r.efforts.length === 0}
                        options={r.efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))}
                        onChange={(e) =>
                          setRow(i, { defaultEffort: e.target.value as ReasoningEffort })
                        }
                      />
                    </label>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            leftIcon={<Plus strokeWidth={2} aria-hidden />}
            disabled={rows.length >= 40}
            onClick={() => setRows((list) => [...list, emptyRow(format)])}
          >
            {tr('添加模型')}
          </Button>
          {touched && rowsError && <InlineError>{rowsError}</InlineError>}
        </section>

        <SwitchRow
          title={tr('启用')}
          hint={tr('停用后成员选不到这些模型，已在用的会话回到默认模型。')}
          checked={enabled}
          onCheckedChange={setEnabled}
        />

        {save.isError && <InlineError>{errorMessage(save.error)}</InlineError>}
      </form>
    </Dialog>
  );
}
