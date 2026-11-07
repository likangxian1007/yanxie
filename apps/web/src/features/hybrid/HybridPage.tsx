import { useState } from 'react';
import { Cloud, Cpu, RotateCw, ShieldCheck, Zap } from 'lucide-react';
import type { HybridRoute, HybridStatus, HybridTask } from '@srh/shared';
import { Page, PageHeader } from '@/components/layout/Page';
import { Badge, Button, RelativeTime, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useHybridStatus, useRedactPreview } from './queries';

/**
 * 混合 AI 看板：本机模型（Intel OpenVINO）与云端模型的分工、实时状态与调用统计，
 * 以及隐私护栏的试运行（粘一段文字，看云端实际会收到什么）。
 */
function taskLabel(task: HybridTask): string {
  switch (task) {
    case 'doc-rewrite':
      return tr('文档润色 / 精简 / 扩写');
    case 'doc-translate':
      return tr('文档翻译');
    case 'doc-summary':
      return tr('文档总结 / 大纲');
    case 'doc-generate':
      return tr('文档续写 / 生成');
    case 'compact':
      return tr('对话上下文压缩');
    case 'report':
      return tr('组会汇报');
    case 'redact':
      return tr('隐私脱敏（识别敏感实体）');
    case 'pdf-translate':
      return tr('整篇 PDF 保版式翻译');
  }
}

function routeLabel(route: HybridRoute): string {
  return route === 'local' ? tr('本地') : route === 'cloud' ? tr('云端') : tr('自动');
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="text-caption text-fg-subtle">{label}</div>
      <div className="mt-1 text-h3 text-fg tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-caption text-fg-subtle">{hint}</div>}
    </div>
  );
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function Overview({ s }: { s: HybridStatus }) {
  const t = s.totals;
  const share = t.calls ? Math.round((t.localCalls / t.calls) * 100) : 0;
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat
        label={tr('本地处理占比')}
        value={`${share}%`}
        hint={tr('{n} 次调用', { n: t.calls })}
      />
      <Stat
        label={tr('本地速度')}
        value={t.avgLocalTps != null ? `${t.avgLocalTps.toFixed(1)} tok/s` : '—'}
        hint={tr('平均耗时 {ms}', { ms: fmtMs(t.avgLocalMs) })}
      />
      <Stat
        label={tr('已脱敏片段')}
        value={String(t.redacted)}
        hint={tr('回退云端 {n} 次', { n: t.fallbacks })}
      />
      <Stat
        label={tr('省下的云端费用')}
        value={`$${t.savedUsd.toFixed(4)}`}
        hint={tr('本地 {n} tokens', { n: t.localTokens })}
      />
    </section>
  );
}

function Endpoints({ s }: { s: HybridStatus }) {
  const qc = useQueryClient();
  const [probing, setProbing] = useState(false);
  const probe = async () => {
    setProbing(true);
    try {
      const next = await api.get<HybridStatus>('/hybrid/status?refresh=1');
      qc.setQueryData(['hybrid', 'status'], next);
    } finally {
      setProbing(false);
    }
  };
  return (
    <section className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center gap-2">
          <Cpu className="size-4 text-success" aria-hidden />
          <span className="text-body font-medium text-fg">{tr('本地端')}</span>
          {s.enabled ? (
            <Badge tone={s.local.up ? 'success' : 'danger'}>
              {s.local.up ? tr('在线') : tr('不可用')}
            </Badge>
          ) : (
            <Badge>{tr('未配置')}</Badge>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={probe} disabled={probing}>
            <RotateCw className={cn('size-3.5', probing && 'animate-spin')} aria-hidden />
            {tr('检测')}
          </Button>
        </div>
        {s.enabled ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
            <dt className="text-fg-subtle">{tr('模型')}</dt>
            <dd className="truncate text-fg">{s.local.model}</dd>
            <dt className="text-fg-subtle">{tr('设备')}</dt>
            <dd className="text-fg">{s.local.device || tr('未注明')}</dd>
            <dt className="text-fg-subtle">{tr('延迟')}</dt>
            <dd className="text-fg">{fmtMs(s.local.latencyMs)}</dd>
            {s.local.checkedAt && (
              <>
                <dt className="text-fg-subtle">{tr('检测于')}</dt>
                <dd className="text-fg">
                  <RelativeTime iso={s.local.checkedAt} />
                </dd>
              </>
            )}
            {s.local.error && !s.local.up && (
              <>
                <dt className="text-fg-subtle">{tr('原因')}</dt>
                <dd className="break-all text-danger">{s.local.error}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="mt-3 text-small text-fg-muted">
            {tr(
              '在服务端 .env 里配置 LOCAL_LLM_BASE_URL 和 LOCAL_LLM_MODEL 后启用，例如本机 OpenVINO Model Server。没有配置时全部走云端。',
            )}
          </p>
        )}
      </div>
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center gap-2">
          <Cloud className="size-4 text-agent" aria-hidden />
          <span className="text-body font-medium text-fg">{tr('云端')}</span>
          <Badge tone={s.cloud.configured ? 'success' : 'danger'}>
            {s.cloud.configured ? tr('在线') : tr('未配置')}
          </Badge>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
          <dt className="text-fg-subtle">{tr('模型')}</dt>
          <dd className="truncate text-fg">{s.cloud.model}</dd>
          <dt className="text-fg-subtle">{tr('平均耗时')}</dt>
          <dd className="text-fg">{fmtMs(s.totals.avgCloudMs)}</dd>
          <dt className="text-fg-subtle">{tr('隐私护栏')}</dt>
          <dd className="text-fg">{s.redact ? tr('开：发往云端前先在本地脱敏') : tr('关')}</dd>
        </dl>
      </div>
    </section>
  );
}

function Routes({ s }: { s: HybridStatus }) {
  return (
    <section>
      <h2 className="mb-2 text-h3 text-fg">{tr('分流规则')}</h2>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-small">
          <thead className="text-left text-fg-subtle">
            <tr className="border-b border-line">
              <th className="px-3 py-2 font-normal">{tr('任务')}</th>
              <th className="px-3 py-2 font-normal">{tr('规则')}</th>
              <th className="px-3 py-2 text-right font-normal">{tr('本地')}</th>
              <th className="px-3 py-2 text-right font-normal">{tr('云端')}</th>
            </tr>
          </thead>
          <tbody>
            {s.routes.map((r) => (
              <tr key={r.task} className="border-b border-line last:border-0">
                <td className="px-3 py-2 text-fg">{taskLabel(r.task)}</td>
                <td className="px-3 py-2">
                  <Badge tone={r.route === 'cloud' ? undefined : 'success'}>
                    {routeLabel(r.route)}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right text-fg tabular-nums">{r.local}</td>
                <td className="px-3 py-2 text-right text-fg tabular-nums">{r.cloud}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-caption text-fg-subtle">
        {tr('「自动」：本地在线且输入不太长时交给本地，否则回退云端。可用 HYBRID_ROUTES 改规则。')}
      </p>
    </section>
  );
}

function Recent({ s }: { s: HybridStatus }) {
  if (!s.recent.length)
    return (
      <p className="text-small text-fg-muted">
        {tr('还没有调用记录。在文档里用一次 AI 润色或翻译试试。')}
      </p>
    );
  return (
    <section>
      <h2 className="mb-2 text-h3 text-fg">{tr('最近调用')}</h2>
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {s.recent.slice(0, 30).map((c, i) => {
          const local = c.target === 'local';
          return (
            <li
              key={`${c.at}-${i}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-small"
            >
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption',
                  local ? 'bg-success-soft text-success' : 'bg-subtle text-fg-muted',
                )}
              >
                {local ? (
                  <Cpu className="size-3" aria-hidden />
                ) : (
                  <Cloud className="size-3" aria-hidden />
                )}
                {local ? tr('本地') : tr('云端')}
              </span>
              <span className="text-fg">{taskLabel(c.task)}</span>
              {c.fallback && <Badge tone="warning">{tr('已回退')}</Badge>}
              {c.redacted > 0 && (
                <span className="inline-flex items-center gap-1 text-caption text-success">
                  <ShieldCheck className="size-3" aria-hidden />
                  {tr('脱敏 {n} 处', { n: c.redacted })}
                </span>
              )}
              {!c.ok && <Badge tone="danger">{tr('失败')}</Badge>}
              <span className="ml-auto flex items-center gap-3 text-caption text-fg-subtle tabular-nums">
                {c.tps != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Zap className="size-3" aria-hidden />
                    {c.tps.toFixed(1)} tok/s
                  </span>
                )}
                <span>{fmtMs(c.ms)}</span>
                <RelativeTime iso={c.at} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const SAMPLE =
  '张伟在样本 S-2031 上测得准确率 93.7%，浓度 0.25 mM，比基线高 4.2%；数据请联系 zhangwei@lab.cn。';

function RedactTry() {
  const [text, setText] = useState(SAMPLE);
  const m = useRedactPreview();
  return (
    <section>
      <h2 className="mb-1 text-h3 text-fg">{tr('隐私护栏试运行')}</h2>
      <p className="mb-2 text-small text-fg-muted">
        {tr('粘一段文字，看云端实际会收到什么。识别和还原都在本机完成。')}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        aria-label={tr('要脱敏的文字')}
        className="w-full rounded-lg border border-line bg-surface p-3 text-small text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-agent/40"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={() => m.mutate(text)} disabled={!text.trim() || m.isPending}>
          <ShieldCheck className="size-3.5" aria-hidden />
          {m.isPending ? tr('脱敏中…') : tr('脱敏')}
        </Button>
        {m.data && (
          <span className="text-caption text-fg-subtle">
            {m.data.usedLocalModel ? tr('规则 + 本机模型识别') : tr('仅规则识别（本机模型未启用）')}
          </span>
        )}
      </div>
      {m.error && <p className="mt-2 text-small text-danger">{(m.error as Error).message}</p>}
      {m.data && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-subtle p-3">
            <div className="mb-1 text-caption text-fg-subtle">{tr('云端看到的内容')}</div>
            <p className="whitespace-pre-wrap break-words text-small text-fg">{m.data.redacted}</p>
          </div>
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="mb-1 text-caption text-fg-subtle">
              {tr('只留在本机的对照表（{n} 项）', { n: m.data.items.length })}
            </div>
            <ul className="space-y-0.5 text-small">
              {m.data.items.map((it) => (
                <li key={it.placeholder} className="flex gap-2">
                  <span className="text-success">{it.placeholder}</span>
                  <span className="text-fg-subtle">→</span>
                  <span className="break-all text-fg">{it.original}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

export function HybridPage() {
  const q = useHybridStatus({ live: true });
  return (
    <Page width="doc">
      <PageHeader
        title={tr('混合 AI')}
        description={tr(
          '高频小任务和隐私内容交给本机模型，复杂推理交给云端；本机不可用时自动回退云端。',
        )}
      />
      {q.isLoading || !q.data ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <Endpoints s={q.data} />
          <Overview s={q.data} />
          <Routes s={q.data} />
          <RedactTry />
          <Recent s={q.data} />
        </div>
      )}
    </Page>
  );
}
