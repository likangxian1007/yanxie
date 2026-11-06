import type { ReviewTargetKind } from '@srh/shared';
import { tr } from '@/lib/i18n';

/** 审阅目标类型的中文名 */
export const TARGET_KIND_LABEL: Record<ReviewTargetKind, string> = {
  document: tr('文档'),
  experiment: tr('内容已移除'),
  report: tr('汇报'),
  thread: tr('线程'),
  plan: tr('计划'),
  message: tr('消息'),
  output: tr('产出'),
  proposal: tr('改动提案'),
  research_record: tr('研究空间'),
  research_finding: tr('研究结论'),
};

/** 发起审阅对话框里可选的目标类型（按常用程度） */
export const SELECTABLE_TARGET_KINDS: ReviewTargetKind[] = [
  'document',
  'research_record',
  'report',
  'thread',
  'plan',
  'message',
];

/** 这些目标可以从列表里选；其余（计划、消息、产出）粘贴 id */
export function isPickableKind(kind: ReviewTargetKind): boolean {
  return (
    kind === 'document' || kind === 'research_record' || kind === 'report' || kind === 'thread'
  );
}

/** 这些目标能拉到“当前版本”内容做对比（计划存成文档时也可以） */
export function hasCurrentContent(kind: ReviewTargetKind, id = ''): boolean {
  return (
    kind === 'document' ||
    kind === 'research_record' ||
    kind === 'report' ||
    (kind === 'plan' && id.startsWith('doc_'))
  );
}

/** 目标在站内的链接；没有独立页面的返回 null */
export function targetHref(pid: string, kind: ReviewTargetKind, id: string): string | null {
  switch (kind) {
    case 'document':
      return `/p/${pid}/docs/${id}`;
    case 'experiment':
      return `/p/${pid}/experiments/${id}`;
    case 'research_record':
      return `/p/${pid}/research/${id}`;
    case 'research_finding':
      return `/p/${pid}/research-findings/${id}`;
    case 'report':
      return `/p/${pid}/reports/${id}`;
    case 'thread':
      return `/p/${pid}/threads/${id}`;
    case 'proposal':
      return `/p/${pid}/proposals/${id}`;
    case 'plan':
      // agent 的计划存成文档（doc_…）；旧数据里也可能是线程
      if (id.startsWith('doc_')) return `/p/${pid}/docs/${id}`;
      if (id.startsWith('thr_')) return `/p/${pid}/threads/${id}`;
      return null;
    default:
      return null;
  }
}

/** 计划目标是一篇文档时，按文档处理（显示标题、对比当前内容） */
export function planDocumentId(kind: ReviewTargetKind, id: string): string | null {
  return kind === 'plan' && id.startsWith('doc_') ? id : null;
}
