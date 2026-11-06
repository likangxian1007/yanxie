import { useSearchParams } from 'react-router';
import { CheckCircle2, Coins, Loader2, RotateCw, XCircle } from 'lucide-react';
import type { CreditKind, CreditLedgerEntry, PayOrderView } from '@srh/shared';
import { Page, PageHeader } from '@/components/layout/Page';
import { Badge, Button, EmptyState, RelativeTime, Skeleton, toast } from '@/components/ui';
import { errorMessage } from '@/features/settings/lib';
import { cn } from '@/lib/cn';
import { locale, tr } from '@/lib/i18n';
import { useBilling, useStartTopup, useTopupOrder } from '../api';

/** 积分显示：整数，千分位 */
export function formatCredits(n: number): string {
  return n.toLocaleString(locale());
}

/** 积分折合美元（1 积分 = 0.001 美元） */
export function creditsToUsd(n: number): string {
  return `$${(n / 1000).toFixed(2)}`;
}

function kindLabel(kind: CreditKind): string {
  switch (kind) {
    case 'signup':
      return tr('注册赠送');
    case 'usage':
      return tr('模型用量');
    case 'topup':
      return tr('充值');
    case 'refund':
      return tr('退款');
    case 'adjust':
      return tr('人工调整');
  }
}

function OrderBanner({ order, loading }: { order: PayOrderView | undefined; loading: boolean }) {
  if (loading || !order || order.status === 'created') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-line bg-surface p-4 text-small text-fg-muted">
        <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin" aria-hidden />
        <span>{tr('正在确认支付结果，到账后余额会自动更新…')}</span>
      </div>
    );
  }
  if (order.status === 'paid') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-line bg-surface p-4 text-small text-fg">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden />
        <span>
          {tr('充值成功，已到账 {credits} 积分。', { credits: formatCredits(order.credits) })}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface p-4 text-small text-fg">
      <XCircle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
      <span>
        {order.status === 'refunded'
          ? tr('这笔订单已退款。')
          : tr('这笔订单没有完成，如已扣款请联系我们。')}
      </span>
    </div>
  );
}

function LedgerRow({ e }: { e: CreditLedgerEntry }) {
  const tokens =
    e.inputTokens != null || e.outputTokens != null
      ? tr('输入 {input} · 输出 {output} tokens', {
          input: formatCredits(e.inputTokens ?? 0),
          output: formatCredits(e.outputTokens ?? 0),
        })
      : null;
  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body text-fg">{kindLabel(e.kind)}</span>
          {e.model && (
            <span className="min-w-0 truncate font-mono text-caption text-fg-subtle">
              {e.model}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-caption break-words text-fg-subtle">
          <RelativeTime iso={e.createdAt} />
          {tokens && <> · {tokens}</>}
        </div>
      </div>
      <span
        className={cn(
          'shrink-0 text-small tabular-nums',
          e.delta > 0 ? 'text-success' : e.delta < 0 ? 'text-fg' : 'text-fg-subtle',
        )}
      >
        {e.delta > 0 ? '+' : ''}
        {formatCredits(e.delta)}
      </span>
    </li>
  );
}

export function BillingPage() {
  const [params] = useSearchParams();
  const ref = params.get('ref');
  const billing = useBilling();
  const order = useTopupOrder(ref);
  const topup = useStartTopup();

  const start = (sku: string) => {
    topup.mutate(sku, {
      onSuccess: (r) => window.location.assign(r.url),
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  if (billing.isPending) {
    return (
      <Page width="doc">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-6 h-28 w-full" />
        <Skeleton className="mt-4 h-40 w-full" />
      </Page>
    );
  }
  if (billing.isError) {
    return (
      <Page width="doc">
        <EmptyState
          icon={Coins}
          title={tr('加载失败')}
          description={errorMessage(billing.error)}
          action={
            <Button
              leftIcon={<RotateCw strokeWidth={1.75} aria-hidden />}
              onClick={() => void billing.refetch()}
            >
              {tr('重试')}
            </Button>
          }
        />
      </Page>
    );
  }

  const b = billing.data;
  return (
    <Page width="doc">
      <PageHeader title={tr('余额与充值')} description={tr('按实际用量计费')} />
      <div className="flex flex-col gap-5">
        {ref && <OrderBanner order={order.data} loading={order.isPending} />}

        <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption text-fg-subtle">{tr('当前余额')}</span>
            {b.exempt && <Badge tone="accent">{tr('管理员免扣费')}</Badge>}
            {!b.enabled && <Badge tone="neutral">{tr('计费未开启')}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span
              className={cn('text-h1 tabular-nums', b.balance <= 0 ? 'text-danger' : 'text-fg')}
            >
              {formatCredits(b.balance)}
            </span>
            <span className="text-small text-fg-subtle">
              {tr('积分 ≈ {usd}', { usd: creditsToUsd(b.balance) })}
            </span>
          </div>
          <p className="mt-2 text-caption text-fg-subtle">
            {tr(
              '1 积分 = 0.001 美元。余额用完后，平台提供的模型会暂停使用；项目自己配置的模型不收费。',
            )}
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-small font-medium text-fg">{tr('充值')}</h2>
          {!b.topupEnabled && (
            <p className="mb-3 text-small text-fg-muted">{tr('在线充值暂未开放')}</p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {b.packs.map((p) => {
              const bonus = p.credits - Math.round(Number(p.price) * 1000);
              return (
                <div
                  key={p.sku}
                  className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
                >
                  <div>
                    <div className="text-h3 text-fg tabular-nums">${p.price}</div>
                    <div className="mt-0.5 text-small text-fg-muted tabular-nums">
                      {tr('{credits} 积分', { credits: formatCredits(p.credits) })}
                    </div>
                    {bonus > 0 && (
                      <div className="mt-1">
                        <Badge tone="success">
                          {tr('多送 {bonus}', { bonus: formatCredits(bonus) })}
                        </Badge>
                      </div>
                    )}
                  </div>
                  <Button
                    className="max-md:h-11"
                    disabled={!b.topupEnabled || topup.isPending}
                    loading={topup.isPending && topup.variables === p.sku}
                    onClick={() => start(p.sku)}
                  >
                    {tr('去支付')}
                  </Button>
                </div>
              );
            })}
          </div>
        </section>

        {b.prices.length > 0 && (
          <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
            <h2 className="text-small font-medium text-fg">{tr('模型价格')}</h2>
            <p className="mt-1 text-caption text-fg-subtle">
              {tr('按实际用量计费；下表是每 100 万 tokens 的大致积分，实际以上游报价为准。')}
            </p>
            <ul className="mt-3 divide-y divide-line">
              {b.prices.map((p) => (
                <li
                  key={p.modelId}
                  className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:gap-3"
                >
                  <span className="min-w-0 flex-1 truncate text-small text-fg">{p.name}</span>
                  <span className="text-caption text-fg-muted tabular-nums">
                    {tr('输入 {input} · 输出 {output}', {
                      input: formatCredits(p.inputPerMillion),
                      output: formatCredits(p.outputPerMillion),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2 className="mb-1 text-small font-medium text-fg">{tr('最近记录')}</h2>
          {b.recent.length === 0 ? (
            <p className="py-4 text-small text-fg-subtle">{tr('还没有记录')}</p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {b.recent.map((e) => (
                <LedgerRow key={e.id} e={e} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </Page>
  );
}
