import { useState } from 'react';
import { Users } from 'lucide-react';
import type { TeamMemberUsage, TeamWalletSummary, TopupPack } from '@srh/shared';
import { Badge, Button, Input, Skeleton, toast } from '@/components/ui';
import { errorMessage } from '@/features/settings/lib';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';
import { useProjectBilling, useSetMemberCap, useStartTopup, useTransferToTeam } from '../api';
import { formatCredits } from '../format';

/** 余额页里每个项目的「团队积分」：成员只看余额和自己本月用量；owner / advisor 可转入、充值、设成员上限。 */
export function TeamWalletSection({
  team,
  personalBalance,
  packs,
  topupEnabled,
}: {
  team: TeamWalletSummary;
  personalBalance: number;
  packs: TopupPack[];
  topupEnabled: boolean;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Users size={16} strokeWidth={1.75} className="text-fg-subtle" aria-hidden />
        <h3 className="min-w-0 truncate text-small font-medium text-fg">{team.projectName}</h3>
        <span className="text-caption text-fg-subtle">{tr('团队积分')}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span
          className={cn('text-h2 tabular-nums', team.balance <= 0 ? 'text-fg-muted' : 'text-fg')}
        >
          {formatCredits(team.balance)}
        </span>
        <span className="text-small text-fg-subtle">{tr('积分')}</span>
      </div>
      <p className="mt-1 text-caption text-fg-subtle tabular-nums">
        {team.monthlyCap === null
          ? tr('你本月用了 {used} 团队积分', { used: formatCredits(team.monthUsed) })
          : tr('你本月用了 {used} / {cap} 团队积分', {
              used: formatCredits(team.monthUsed),
              cap: formatCredits(team.monthlyCap),
            })}
      </p>
      <p className="mt-2 text-caption text-fg-subtle">
        {tr(
          '在这个项目里用平台模型，会先扣团队积分；团队积分用完或超过你的月上限时，改扣你的个人积分。',
        )}
      </p>
      {team.canManage && (
        <ManageTeam
          projectId={team.projectId}
          personalBalance={personalBalance}
          packs={packs}
          topupEnabled={topupEnabled}
        />
      )}
    </section>
  );
}

function ManageTeam({
  projectId,
  personalBalance,
  packs,
  topupEnabled,
}: {
  projectId: string;
  personalBalance: number;
  packs: TopupPack[];
  topupEnabled: boolean;
}) {
  const [amount, setAmount] = useState('');
  const transfer = useTransferToTeam(projectId);
  const topup = useStartTopup();
  const detail = useProjectBilling(projectId);
  const n = Number(amount);
  const valid = Number.isInteger(n) && n > 0 && n <= personalBalance;

  const submit = () => {
    if (!valid) return;
    transfer.mutate(n, {
      onSuccess: () => {
        setAmount('');
        toast.success(tr('已转入 {credits} 积分', { credits: formatCredits(n) }));
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
      <div>
        <label htmlFor={`transfer-${projectId}`} className="text-small text-fg">
          {tr('从个人积分转入团队')}
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            id={`transfer-${projectId}`}
            inputMode="numeric"
            placeholder={tr('最多 {max}', { max: formatCredits(personalBalance) })}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/gu, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            className="max-md:h-11"
            wrapperClassName="sm:max-w-48"
          />
          <Button
            className="max-md:h-11"
            variant="secondary"
            disabled={!valid || transfer.isPending}
            loading={transfer.isPending}
            onClick={submit}
          >
            {tr('转入团队')}
          </Button>
        </div>
      </div>

      {packs.length > 0 && (
        <div>
          <div className="text-small text-fg">{tr('为团队充值')}</div>
          {!topupEnabled && (
            <p className="mt-1 text-caption text-fg-subtle">{tr('在线充值暂未开放')}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {packs.map((p) => (
              <Button
                key={p.sku}
                size="sm"
                variant="secondary"
                className="max-md:h-11"
                disabled={!topupEnabled || topup.isPending}
                loading={topup.isPending}
                onClick={() =>
                  topup.mutate(
                    { sku: p.sku, wallet: 'team', projectId },
                    {
                      onSuccess: (r) => window.location.assign(r.url),
                      onError: (err) => toast.error(errorMessage(err)),
                    },
                  )
                }
              >
                <span className="tabular-nums">
                  {tr('${price} · {credits} 积分', {
                    price: p.price,
                    credits: formatCredits(p.credits),
                  })}
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="text-small text-fg">{tr('成员本月用量')}</div>
        <p className="mt-0.5 text-caption text-fg-subtle">
          {tr('月上限留空表示不限；超过上限的成员会改扣自己的个人积分。')}
        </p>
        {detail.isPending ? (
          <Skeleton className="mt-2 h-20 w-full" />
        ) : detail.isError ? (
          <p className="mt-2 text-caption text-danger">{errorMessage(detail.error)}</p>
        ) : !detail.data.members?.length ? (
          <p className="mt-2 text-caption text-fg-subtle">{tr('还没有成员')}</p>
        ) : (
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {detail.data.members.map((m) => (
              <MemberRow key={m.userId} projectId={projectId} m={m} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MemberRow({ projectId, m }: { projectId: string; m: TeamMemberUsage }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = useSetMemberCap(projectId);
  const value = draft ?? (m.monthlyCap === null ? '' : String(m.monthlyCap));
  const over = m.monthlyCap !== null && m.monthUsed >= m.monthlyCap;

  const commit = () => {
    if (draft === null) return;
    const next = draft === '' ? null : Number(draft);
    if (next === m.monthlyCap) {
      setDraft(null);
      return;
    }
    save.mutate(
      { userId: m.userId, monthlyCap: next },
      {
        onSuccess: () => setDraft(null),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <div className="min-w-0 flex-1">
        <span className="truncate text-small text-fg">{m.name}</span>
        <span className="ml-2 text-caption text-fg-subtle tabular-nums">
          {tr('本月 {used}', { used: formatCredits(m.monthUsed) })}
        </span>
        {over && (
          <Badge tone="warning" className="ml-2">
            {tr('已到上限')}
          </Badge>
        )}
      </div>
      <Input
        size="sm"
        inputMode="numeric"
        aria-label={tr('{name} 的月上限', { name: m.name })}
        placeholder={tr('不限')}
        value={value}
        disabled={save.isPending}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/gu, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="text-right tabular-nums max-md:h-10"
        wrapperClassName="w-28"
      />
    </li>
  );
}
