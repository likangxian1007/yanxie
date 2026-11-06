import type { WorkClaim } from '@srh/shared';
import { tr } from '@/lib/i18n';

const KIND_LABEL: Record<WorkClaim['resourceKind'], string> = {
  document: tr('文档'),
  doc_section: tr('文档章节'),
  file: tr('文件'),
  experiment: tr('实验'),
  research: tr('研究空间'),
  card: tr('卡片'),
  topic: tr('议题'),
};

/** 认领对象的可读名字：resourceRef 形如 doc:<id>#<节>，这里只做最小转换。 */
export function claimTarget(c: WorkClaim): string {
  const ref = c.resourceRef.replace(/^[a-z_]+:/u, '');
  return `${KIND_LABEL[c.resourceKind]} ${ref}`;
}
