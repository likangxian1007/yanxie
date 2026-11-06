import { useEffect, useState, type HTMLAttributes } from 'react';
import { relativeTimeZh } from '@srh/shared';
import { cn } from '@/lib/cn';
import { formatFullTimeZh } from '@/lib/time';
import { tr } from '@/lib/i18n';

/** 将来的时间：5 分钟后 / 3 小时后 / 2 天后；不是将来返回 null。 */
function futureZh(iso: string, now: Date): string | null {
  const diff = new Date(iso).getTime() - now.getTime();
  if (!(diff > 60_000)) return null;
  const min = Math.round(diff / 60_000);
  if (min < 60) return tr('{min} 分钟后', { min });
  const h = Math.round(min / 60);
  if (h < 24) return tr('{h} 小时后', { h });
  return tr('{Math} 天后', { Math: Math.round(h / 24) });
}

export interface RelativeTimeProps extends HTMLAttributes<HTMLTimeElement> {
  iso: string;
}

/** 相对时间（刚刚 / 3 分钟前 …），每分钟刷新；悬停显示完整时间（STYLE §7）。 */
export function RelativeTime({ iso, className, ...props }: RelativeTimeProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <time
      dateTime={iso}
      title={formatFullTimeZh(iso)}
      className={cn('tabular-nums', className)}
      {...props}
    >
      {futureZh(iso, now) ?? relativeTimeZh(iso, now)}
    </time>
  );
}
