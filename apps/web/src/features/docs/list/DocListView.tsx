import { useState } from 'react';
import { Link } from 'react-router';
import { ResourcePreviewLink } from '@/features/resource-preview/ResourcePreviewLink';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, Pin } from 'lucide-react';
import {
  AvatarStack,
  ContextMenu,
  RelativeTime,
  useContextMenu,
  type AvatarStackMember,
} from '@/components/ui';
import { SpaceBadge } from '@/features/sharing/SpaceBadge';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { DocKindIcon } from '../kinds';
import { ActorAvatar } from './ActorAvatar';
import { DocActionsMenu, DocMenuItems, type DocActions } from './DocActionsMenu';
import type { DocNode } from './doc-tree';
import { tr, trServer } from '@/lib/i18n';

export interface DocViewProps {
  hrefOf: (id: string) => string;
  actions: DocActions;
  canEdit: boolean;
  /** 正在编辑某文档的人（暂无数据源，预留） */
  editorsOf?: ((id: string) => AvatarStackMember[] | undefined) | undefined;
}

/** 列表视图：树形（parentId 组装），子文档可展开 */
export function DocListView({
  nodes,
  expandAll,
  ...view
}: DocViewProps & { nodes: DocNode[]; expandAll: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const { variants, stagger } = useMotionPreset();
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <motion.ul
      variants={stagger()}
      initial="hidden"
      animate="visible"
      aria-label={tr('文档列表')}
      className="research-list"
    >
      {nodes.map((node) => (
        <motion.li key={node.doc.id} variants={variants.fadeUp} className="research-row">
          <DocRow
            node={node}
            depth={0}
            isOpen={(id) => expandAll || expanded.has(id)}
            onToggle={toggle}
            {...view}
          />
        </motion.li>
      ))}
    </motion.ul>
  );
}

function DocRow({
  node,
  depth,
  isOpen,
  onToggle,
  hrefOf,
  actions,
  canEdit,
  editorsOf,
}: DocViewProps & {
  node: DocNode;
  depth: number;
  isOpen: (id: string) => boolean;
  onToggle: (id: string) => void;
}) {
  const { doc, children } = node;
  const open = children.length > 0 && isOpen(doc.id);
  const { variants } = useMotionPreset();
  const editors = [...(editorsOf?.(doc.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const actor = doc.updatedBy ?? doc.createdBy;
  // 右键（或菜单键 / Shift+F10）弹出和「⋯」相同的菜单；Shift + 右键保留浏览器原生菜单
  const ctx = useContextMenu();
  const pinned = actions.isPinned(doc);

  return (
    <>
      <div
        onContextMenu={ctx.onContextMenu}
        onKeyDown={ctx.onKeyDown}
        className={cn(
          'group flex min-w-0 items-center gap-1 pr-2 transition-colors duration-(--dur-fast) hover:bg-subtle',
          ctx.open && 'bg-subtle',
        )}
        style={{ paddingLeft: `${Math.min(depth, 4) * 16 + 4}px` }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            aria-label={
              open
                ? tr('收起「{title}」的子文档', { title: doc.title })
                : tr('展开「{title}」的子文档', { title: doc.title })
            }
            aria-expanded={open}
            onClick={() => onToggle(doc.id)}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-fg-subtle hover:bg-muted hover:text-fg"
          >
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              aria-hidden
              className={cn(
                'transition-transform duration-(--dur-fast) ease-(--ease-standard)',
                open && 'rotate-90',
              )}
            />
          </button>
        ) : (
          <span aria-hidden className="size-6 shrink-0" />
        )}
        <Link
          data-list-item={`doc:${doc.id}`}
          to={hrefOf(doc.id)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-sm py-3"
        >
          <DocKindIcon kind={doc.kind} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-body font-medium text-fg">
                {doc.title || tr('未命名')}
              </span>
              <SpaceBadge
                space={doc.space}
                ownerUserId={doc.ownerUserId}
                access={doc.access}
                shared={doc.shared}
              />
              {pinned && (
                <Pin
                  size={12}
                  strokeWidth={2}
                  role="img"
                  aria-label={tr('已置顶')}
                  className="shrink-0 text-fg-subtle"
                />
              )}
              {children.length > 0 && (
                <span className="shrink-0 text-caption text-fg-subtle tabular-nums">
                  {children.length}
                </span>
              )}
            </span>
            <span className="block truncate text-small text-fg-muted">
              <RelativeTime iso={doc.updatedAt} className="mr-1.5 sm:hidden" />
              {doc.excerpt.replace(/\s+/gu, ' ').trim() || tr('还没有内容')}
            </span>
          </span>
          <span className="hidden shrink-0 items-center gap-2 text-caption text-fg-subtle sm:flex">
            <ActorAvatar actor={actor} />
            <span className="max-w-24 truncate">{trServer(actor.name)}</span>
            <RelativeTime iso={doc.updatedAt} className="w-16 text-right" />
          </span>
        </Link>
        {editors.length > 0 && (
          <AvatarStack members={editors} size={20} max={3} expand="left" label={tr('正在编辑')} />
        )}
        <ResourcePreviewLink
          type="doc"
          id={doc.id}
          aria-label={tr('预览「{value}」', { value: doc.title || tr('未命名') })}
          className="relative shrink-0 rounded-md px-2 py-2 text-small text-fg-muted hover:bg-muted hover:text-fg max-md:min-h-11"
        >
          {tr('预览')}
        </ResourcePreviewLink>
        <DocActionsMenu
          doc={doc}
          actions={actions}
          canEdit={canEdit}
          className="opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 md:opacity-0 aria-expanded:opacity-100"
        />
        <ContextMenu
          at={ctx.at}
          onClose={ctx.close}
          label={tr('「{value}」的操作', { value: doc.title || tr('未命名') })}
        >
          <DocMenuItems doc={doc} actions={actions} canEdit={canEdit} />
        </ContextMenu>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            key="children"
            variants={variants.fadeIn}
            initial="hidden"
            animate="visible"
            exit="exit"
            aria-label={tr('「{title}」的子文档', { title: doc.title })}
          >
            {children.map((child) => (
              <li key={child.doc.id}>
                <DocRow
                  node={child}
                  depth={depth + 1}
                  isOpen={isOpen}
                  onToggle={onToggle}
                  hrefOf={hrefOf}
                  actions={actions}
                  canEdit={canEdit}
                  editorsOf={editorsOf}
                />
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </>
  );
}
