import type { DocumentKind } from '@srh/shared';
import { FileText, LayoutTemplate, Upload } from 'lucide-react';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { paletteVar } from '@/lib/palette';
import { DOC_KIND_META, DOC_KINDS, DocKindIcon } from '../kinds';
import { DOC_TEMPLATES, type DocTemplate } from '../templates';
import { tr } from '@/lib/i18n';

const QUICK_TEMPLATES = [
  'weekly-report',
  'experiment-sheet',
  'group-meeting-slides',
  'latex-article',
];

/** 空项目：介绍四类文档 + 模板快捷入口 */
export function DocsEmpty({
  canEdit,
  pending,
  onCreate,
  onTemplate,
  onGallery,
  onUpload,
}: {
  canEdit: boolean;
  pending: string | null;
  onCreate: (kind: DocumentKind) => void;
  onTemplate: (t: DocTemplate) => void;
  onGallery: () => void;
  /** 上传 Word / Excel / PPT / LaTeX 等文件导入 */
  onUpload?: () => void;
}) {
  const quick = QUICK_TEMPLATES.map((id) => DOC_TEMPLATES.find((t) => t.id === id)).filter(
    (t): t is DocTemplate => Boolean(t),
  );
  return (
    <div className="pb-4">
      <EmptyState
        icon={FileText}
        title={tr('还没有文档')}
        action={
          canEdit ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="primary"
                leftIcon={<LayoutTemplate strokeWidth={1.75} aria-hidden />}
                onClick={onGallery}
              >
                {tr('从模板新建')}
              </Button>
              {onUpload && (
                <Button
                  variant="secondary"
                  leftIcon={<Upload strokeWidth={1.75} aria-hidden />}
                  onClick={onUpload}
                >
                  {tr('上传文件')}
                </Button>
              )}
            </div>
          ) : undefined
        }
        className="pb-8"
      />
      <ul className="research-list mx-auto max-w-3xl">
        {DOC_KINDS.map((kind) => {
          const meta = DOC_KIND_META[kind];
          return (
            <li key={kind} className="research-row">
              <button
                type="button"
                disabled={!canEdit || pending !== null}
                onClick={() => onCreate(kind)}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-subtle disabled:cursor-default"
              >
                <DocKindIcon kind={kind} size="lg" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-h3 text-fg">
                    {canEdit
                      ? tr('新建{value}{label}', {
                          value: /^[A-Za-z]/u.test(meta.label) ? ' ' : '',
                          label: meta.label,
                        })
                      : meta.label}
                    {pending === kind && <Spinner className="text-accent" />}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {canEdit && (
        <div className="mx-auto mt-6 flex max-w-3xl flex-wrap items-center gap-2">
          <span className="text-caption text-fg-subtle">{tr('常用模板')}</span>
          {quick.map((t) => {
            const { icon: Icon, tone } = DOC_KIND_META[t.kind];
            return (
              <Button
                key={t.id}
                size="sm"
                variant="subtle"
                loading={pending === t.id}
                disabled={pending !== null && pending !== t.id}
                leftIcon={
                  <Icon strokeWidth={1.75} aria-hidden style={{ color: paletteVar(tone) }} />
                }
                onClick={() => onTemplate(t)}
              >
                {t.title}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
