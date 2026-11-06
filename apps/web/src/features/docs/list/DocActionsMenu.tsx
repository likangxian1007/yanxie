import type { DocumentMeta } from '@srh/shared';
import {
  AppWindow,
  Archive,
  Ellipsis,
  ExternalLink,
  FolderInput,
  Link2,
  PenLine,
  Pin,
  PinOff,
  Share2,
} from 'lucide-react';
import { accessAtLeast } from '@srh/shared';
import { IconButton, Menu, MenuItem, MenuSeparator } from '@/components/ui';
import { tr } from '@/lib/i18n';

export interface DocActions {
  onOpen: (doc: DocumentMeta) => void;
  /** 在浏览器新标签页打开 */
  onOpenInNewTab: (doc: DocumentMeta) => void;
  onRename: (doc: DocumentMeta) => void;
  onMove: (doc: DocumentMeta) => void;
  onArchive: (doc: DocumentMeta) => void;
  onCopyLink: (doc: DocumentMeta) => void;
  /** 置顶（lib/pins，和线程共用一组、跟账号走）：置顶的文档排在列表最前面 */
  isPinned: (doc: DocumentMeta) => boolean;
  onTogglePin: (doc: DocumentMeta) => void;
  /** 分享与权限面板（个人 / 团队空间，§2.19） */
  onShare?: (doc: DocumentMeta) => void;
}

const icon = (Icon: typeof PenLine) => <Icon strokeWidth={1.75} aria-hidden />;

/**
 * 一篇文档的全部菜单项。「⋯」按钮和右键菜单共用，两处的动作和顺序完全一致。
 * 文档没有标签字段，所以这里不提供「加标签」。
 */
export function DocMenuItems({
  doc,
  actions,
  canEdit,
}: {
  doc: DocumentMeta;
  actions: DocActions;
  canEdit: boolean;
}) {
  const pinned = actions.isPinned(doc);
  // 别人分享给我的文档按分享级别：只有可编辑才能改名、移动、归档
  const editable = canEdit && (!doc.access || accessAtLeast(doc.access, 'edit'));
  return (
    <>
      <MenuItem icon={icon(ExternalLink)} onSelect={() => actions.onOpen(doc)}>
        {tr('打开')}
      </MenuItem>
      <MenuItem icon={icon(AppWindow)} onSelect={() => actions.onOpenInNewTab(doc)}>
        {tr('在新标签页打开')}
      </MenuItem>
      <MenuItem icon={icon(Link2)} onSelect={() => actions.onCopyLink(doc)}>
        {tr('复制链接')}
      </MenuItem>
      {actions.onShare && (
        <MenuItem icon={icon(Share2)} onSelect={() => actions.onShare?.(doc)}>
          {tr('分享与权限…')}
        </MenuItem>
      )}
      <MenuItem
        icon={icon(pinned ? PinOff : Pin)}
        onSelect={() => actions.onTogglePin(doc)}
        {...(pinned ? {} : { description: tr('排在文档列表最前面') })}
      >
        {pinned ? tr('取消置顶') : tr('置顶')}
      </MenuItem>
      {editable && (
        <>
          <MenuSeparator />
          <MenuItem icon={icon(PenLine)} onSelect={() => actions.onRename(doc)}>
            {tr('重命名')}
          </MenuItem>
          <MenuItem icon={icon(FolderInput)} onSelect={() => actions.onMove(doc)}>
            {tr('移动到…')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={icon(Archive)} danger onSelect={() => actions.onArchive(doc)}>
            {tr('归档')}
          </MenuItem>
        </>
      )}
    </>
  );
}

/** 行 / 卡片上的“更多”菜单 */
export function DocActionsMenu({
  doc,
  actions,
  canEdit,
  className,
}: {
  doc: DocumentMeta;
  actions: DocActions;
  canEdit: boolean;
  className?: string;
}) {
  return (
    <Menu
      align="end"
      label={tr('「{value}」的操作', { value: doc.title || tr('未命名') })}
      trigger={
        <IconButton label={tr('更多操作')} size="sm" className={className}>
          <Ellipsis strokeWidth={1.75} aria-hidden />
        </IconButton>
      }
    >
      <DocMenuItems doc={doc} actions={actions} canEdit={canEdit} />
    </Menu>
  );
}
