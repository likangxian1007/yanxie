import { Link } from 'react-router';
import { Coins } from 'lucide-react';
import { Popover } from '@/components/ui';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';
import { useBilling, useProjectBilling } from '../api';
import { LOW_CREDITS, formatCredits } from '../format';

/**
 * 聊天框里的积分提示（模型选择器旁边）：显示这次会扣哪个钱包和余额，点开看两个余额和当前模型价格。
 * 计费没开、或者免扣费账号时不显示。个人会话 / 个人库只看个人积分。
 */
export function ComposerCredits({
  projectId,
  personal = false,
  modelId,
}: {
  projectId: string;
  personal?: boolean;
  /** `<providerId>/<model>`，用来查价格；项目自配的模型不在价格表里 = 不收费 */
  modelId?: string | null;
}) {
  const me = useBilling();
  const project = useProjectBilling(personal ? null : projectId);
  const b = me.data;
  if (!b || !b.enabled || b.exempt) return null;

  const team = !personal ? project.data : undefined;
  const source = team?.source ?? 'personal';
  const balance = source === 'team' ? team!.balance : b.balance;
  const price = modelId ? b.prices.find((p) => p.modelId === modelId) : undefined;
  const free = !!modelId && b.prices.length > 0 && !price;
  const empty = balance <= 0 && (!team || team.personalBalance <= 0);
  const low = !empty && balance < LOW_CREDITS;
  const value = formatCredits(balance);
  const label = source === 'team' ? tr('团队') : tr('个人');

  return (
    <Popover
      label={tr('积分')}
      side="top"
      align="end"
      autoFocus={false}
      trigger={
        <button
          type="button"
          aria-label={
            empty ? tr('余额不足，去充值') : tr('{wallet}积分 {value}', { wallet: label, value })
          }
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption tabular-nums hover:bg-subtle max-md:h-10',
            empty ? 'text-danger' : low ? 'text-warning' : 'text-fg-subtle',
          )}
        >
          <Coins size={14} strokeWidth={1.75} aria-hidden />
          {empty ? (
            <span className="whitespace-nowrap">{tr('余额不足 · 去充值')}</span>
          ) : (
            <span className="whitespace-nowrap">
              <span className="max-sm:hidden">{label} </span>
              <span className="inline-block max-w-16 truncate align-bottom">{value}</span>
            </span>
          )}
        </button>
      }
    >
      {(close) => (
        <div className="flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-2 p-2 text-small">
          {team && (
            <Row
              name={tr('团队积分')}
              value={team.balance}
              active={source === 'team'}
              hint={
                team.monthlyCap !== null
                  ? tr('本月 {used} / {cap}', {
                      used: formatCredits(team.monthUsed),
                      cap: formatCredits(team.monthlyCap),
                    })
                  : undefined
              }
            />
          )}
          <Row name={tr('个人积分')} value={b.balance} active={source === 'personal'} />
          <p className="text-caption text-fg-subtle">
            {personal
              ? tr('个人会话只扣你的个人积分。')
              : tr('先扣团队积分，用完或超过月上限后扣个人积分。')}
          </p>
          {(price || free) && (
            <div className="border-t border-line pt-2 text-caption text-fg-muted tabular-nums">
              {price
                ? tr('{name}：输入 {input} · 输出 {output} 积分 / 百万 tokens', {
                    name: price.name,
                    input: formatCredits(price.inputPerMillion),
                    output: formatCredits(price.outputPerMillion),
                  })
                : tr('当前模型是项目自己配置的，不收费')}
            </div>
          )}
          <Link
            to="/billing"
            onClick={close}
            className="rounded-md px-2 py-1.5 text-small text-accent hover:bg-subtle max-md:py-2.5"
          >
            {tr('余额与充值')}
          </Link>
        </div>
      )}
    </Popover>
  );
}

function Row({
  name,
  value,
  active,
  hint,
}: {
  name: string;
  value: number;
  active: boolean;
  hint?: string | undefined;
}) {
  return (
    <div className="flex items-baseline gap-2 px-2">
      <span className={cn('flex-1', active ? 'text-fg' : 'text-fg-muted')}>
        {name}
        {active && <span className="ml-1 text-caption text-fg-subtle">{tr('· 当前')}</span>}
      </span>
      <span className="flex flex-col items-end">
        <span
          className={cn(
            'tabular-nums',
            value <= 0 ? 'text-danger' : value < LOW_CREDITS ? 'text-warning' : 'text-fg',
          )}
        >
          {formatCredits(value)}
        </span>
        {hint && <span className="text-caption text-fg-subtle tabular-nums">{hint}</span>}
      </span>
    </div>
  );
}
