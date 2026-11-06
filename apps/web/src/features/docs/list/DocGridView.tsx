import { Link } from 'react-router';
import { SpaceBadge } from '@/features/sharing/SpaceBadge';
import { ResourcePreviewLink } from '@/features/resource-preview/ResourcePreviewLink';
import { motion } from 'motion/react';
import type { DocumentMeta } from '@srh/shared';
import { AvatarStack, Card, ContextMenu, RelativeTime, useContextMenu } from '@/components/ui';
import { useMotionPreset } from '@/lib/motion';
import { paletteVar } from '@/lib/palette';
import { DOC_KIND_META, DocKindIcon } from '../kinds';
import { ActorAvatar } from './ActorAvatar';
import { DocActionsMenu, DocMenuItems } from './DocActionsMenu';
import type { DocViewProps } from './DocListView';
import { DocPreview } from './DocPreview';
import { tr, trServer } from '@/lib/i18n';

/** 网格视图：类型色带 + 内容预览 + 标题与时间 */
export function DocGridView({ docs, ...view }: DocViewProps & { docs: DocumentMeta[] }) {
  const { variants, stagger } = useMotionPreset();
  return (
    <motion.ul
      variants={stagger()}
      initial="hidden"
      animate="visible"
      aria-label={tr('文档列表')}
      className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4"
    >
      {docs.map((doc) => (
        <motion.li key={doc.id} variants={variants.fadeUp} className="research-row min-w-0">
          <DocGridCard doc={doc} {...view} />
        </motion.li>
      ))}
    </motion.ul>
  );
}

function DocGridCard({
  doc,
  hrefOf,
  actions,
  canEdit,
  editorsOf,
}: DocViewProps & { doc: DocumentMeta }) {
  const meta = DOC_KIND_META[doc.kind];
  const editors = [...(editorsOf?.(doc.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const actor = doc.updatedBy ?? doc.createdBy;
  // 和列表行一样：右键 / 菜单键弹出与「⋯」相同的菜单
  const ctx = useContextMenu();
  return (
    <Card
      interactive
      padding="none"
      className="group overflow-hidden"
      onContextMenu={ctx.onContextMenu}
      onKeyDown={ctx.onKeyDown}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-1"
        style={{ backgroundColor: paletteVar(meta.tone) }}
      />
      <Link
        data-list-item={`doc:${doc.id}`}
        to={hrefOf(doc.id)}
        className="flex flex-col rounded-lg"
      >
        <div className="h-32 border-b border-line bg-subtle/60 px-3 pt-4 pb-3">
          <DocPreview kind={doc.kind} excerpt={doc.excerpt} />
        </div>
        <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-3">
          <DocKindIcon kind={doc.kind} size="sm" className="mt-0.5" label={meta.label} />
          <div className="min-w-0 flex-1 pr-6">
            <p className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-body font-medium text-fg">
                {doc.title || tr('未命名')}
              </span>
              <SpaceBadge
                space={doc.space}
                ownerUserId={doc.ownerUserId}
                access={doc.access}
                shared={doc.shared}
              />
            </p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-fg-subtle">
              <ActorAvatar actor={actor} size={20} />
              <span className="truncate">{trServer(actor.name)}</span>
              <span aria-hidden>·</span>
              <RelativeTime iso={doc.updatedAt} className="shrink-0" />
            </p>
          </div>
        </div>
      </Link>
      {editors.length > 0 && (
        <AvatarStack
          members={editors}
          size={20}
          max={3}
          label={tr('正在编辑')}
          className="absolute top-3 left-3"
        />
      )}
      <ResourcePreviewLink
        type="doc"
        id={doc.id}
        aria-label={tr('预览「{value}」', { value: doc.title || tr('未命名') })}
        className="absolute top-3 right-2 rounded-md bg-surface px-2 py-2 text-small text-fg-muted hover:bg-muted max-md:min-h-11"
      >
        {tr('预览')}
      </ResourcePreviewLink>
      <DocActionsMenu
        doc={doc}
        actions={actions}
        canEdit={canEdit}
        className="absolute right-2 bottom-3 opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 md:opacity-0 aria-expanded:opacity-100"
      />
      <ContextMenu
        at={ctx.at}
        onClose={ctx.close}
        label={tr('「{value}」的操作', { value: doc.title || tr('未命名') })}
      >
        <DocMenuItems doc={doc} actions={actions} canEdit={canEdit} />
      </ContextMenu>
    </Card>
  );
}
