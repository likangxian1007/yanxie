import { Link } from 'react-router';
import { Coins } from 'lucide-react';
import { cn } from '@/lib/cn';
import { locale, tr } from '@/lib/i18n';
import { useBilling } from './api';

/** 顶栏余额：只在开启计费、且不是免扣费账号时显示；点击进「余额与充值」。 */
export function BalanceChip({ className }: { className?: string }) {
  const q = useBilling();
  const b = q.data;
  if (!b || !b.enabled || b.exempt) return null;
  const low = b.balance <= 0;
  const value = b.balance.toLocaleString(locale());
  return (
    <Link
      to="/billing"
      title={tr('余额与充值')}
      aria-label={tr('余额 {value} 积分，去充值', { value })}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-caption tabular-nums hover:bg-subtle max-md:h-10',
        low ? 'text-danger' : 'text-fg-muted',
        className,
      )}
    >
      <Coins size={14} strokeWidth={1.75} aria-hidden />
      <span className="max-w-20 truncate">{value}</span>
    </Link>
  );
}
