import { motion } from 'motion/react';
import { Dialog, Spinner } from '@/components/ui';
import { useMotionPreset } from '@/lib/motion';
import { paletteVar } from '@/lib/palette';
import { DOC_KIND_META, DOC_KINDS, DocKindIcon } from '../kinds';
import { templatesByKind, type DocTemplate } from '../templates';
import { DocPreview } from './DocPreview';
import { tr } from '@/lib/i18n';

export interface TemplateGalleryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (template: DocTemplate) => void;
  /** 正在用哪个模板新建（显示加载中，其余禁用） */
  pendingId: string | null;
}

/** 模板画廊：按类型分组的卡片网格，点选即新建并打开 */
export function TemplateGallery({ open, onOpenChange, onPick, pendingId }: TemplateGalleryProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={tr('从模板新建')}
      description={tr('挑一个起点，新建后所有人都可以一起改。')}
    >
      <div className="flex flex-col gap-6">
        {DOC_KINDS.map((kind) => (
          <section key={kind} aria-labelledby={`tpl-${kind}`}>
            <h3 id={`tpl-${kind}`} className="mb-2.5 flex items-center gap-2 text-h3 text-fg">
              <DocKindIcon kind={kind} size="sm" />
              {DOC_KIND_META[kind].label}
            </h3>
            <ul className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:grid-cols-3">
              {templatesByKind(kind).map((t) => (
                <li key={t.id} className="min-w-0">
                  <TemplateCard
                    template={t}
                    pending={pendingId === t.id}
                    disabled={pendingId !== null}
                    onPick={onPick}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function TemplateCard({
  template,
  pending,
  disabled,
  onPick,
}: {
  template: DocTemplate;
  pending: boolean;
  disabled: boolean;
  onPick: (t: DocTemplate) => void;
}) {
  const { spring, reduced } = useMotionPreset();
  const tone = DOC_KIND_META[template.kind].tone;
  return (
    <motion.button
      type="button"
      disabled={disabled}
      aria-busy={pending || undefined}
      onClick={() => onPick(template)}
      whileHover={disabled || reduced ? undefined : { y: -2 }}
      transition={spring.gentle}
      className="relative flex w-full cursor-pointer flex-col overflow-hidden rounded-lg border border-line bg-surface text-left shadow-sm transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-standard) hover:border-line-strong hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-1"
        style={{ backgroundColor: paletteVar(tone) }}
      />
      <span className="block h-24 border-b border-line bg-subtle/60 px-3 pt-3.5 pb-2.5">
        <DocPreview kind={template.kind} excerpt={template.markdown} />
      </span>
      <span className="flex items-start gap-2 px-3 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-fg">{template.title}</span>
          <span className="block truncate text-small text-fg-muted">{template.description}</span>
        </span>
        {pending && <Spinner className="mt-0.5 text-accent" />}
      </span>
    </motion.button>
  );
}
