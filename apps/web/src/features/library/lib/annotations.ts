import type { PaperAnnotation, AnnotationColor } from '@srh/shared';
import { tr } from '@/lib/i18n';
export const ANNOTATION_COLORS: Record<AnnotationColor, string> = {
  yellow: tr('黄色'),
  green: tr('绿色'),
  blue: tr('蓝色'),
  pink: tr('粉色'),
};
export const annotationLabel = (a: Pick<PaperAnnotation, 'kind' | 'page' | 'label'>) =>
  tr('{value} · 第 {page} 页{value2}', {
    value: a.kind === 'highlight' ? tr('高亮') : tr('批注'),
    page: a.page,
    value2: a.label ? ` · ${a.label}` : '',
  });
