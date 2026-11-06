import { ACCESS_LEVEL_TEXT, type AccessLevel, type ResourceSpace } from '@srh/shared';
import { Eye, Link2, MessageSquare, PenLine } from 'lucide-react';
import { Badge } from '@/components/ui';
import { useMeUser } from '@/lib/session';
import { tr } from '@/lib/i18n';

/**
 * 列表行上的空间标记（安静、不抢标题）：
 * - 我的个人资源已经分享出去 → 「已分享」
 * - 别人分享给我的 → 我的权限（可阅读 / 可评论 / 可编辑）
 * 团队空间的资源不显示。
 */
export function SpaceBadge({
  space,
  ownerUserId,
  access,
  shared,
}: {
  space?: ResourceSpace | undefined;
  ownerUserId?: string | null | undefined;
  access?: AccessLevel | undefined;
  shared?: boolean | undefined;
}) {
  const me = useMeUser()?.id ?? null;
  if ((space ?? 'team') === 'team') return null;
  if (ownerUserId === me) {
    if (!shared) return null;
    return (
      <Badge className="shrink-0 gap-1">
        <Link2 className="size-3" strokeWidth={2} aria-hidden />
        {tr('已分享')}
      </Badge>
    );
  }
  if (!access || access === 'none' || access === 'manage') return null;
  const Icon = access === 'edit' ? PenLine : access === 'comment' ? MessageSquare : Eye;
  return (
    <Badge
      tone={access === 'edit' ? 'accent' : 'neutral'}
      className="shrink-0 gap-1"
      title={tr('别人分享给你：{value}', { value: ACCESS_LEVEL_TEXT[access] })}
    >
      <Icon className="size-3" strokeWidth={2} aria-hidden />
      {ACCESS_LEVEL_TEXT[access]}
    </Badge>
  );
}
