import type { DocumentKind } from '@srh/shared';
import { ApiRequestError } from '@/lib/api';

/** 内嵌文档的纯逻辑（NodeView 与测试共用） */
export const docHref = (pid: string, docId: string) => `/p/${pid}/docs/${docId}`;

/** 是否“有实时内容可看”的类型（表格、幻灯片）；文档 / LaTeX 只显示卡片 */
export const isLiveKind = (kind: DocumentKind) => kind === 'sheet' || kind === 'slides';

/** 元信息加载失败时的降级状态：404 / 403 = 原文档没了或没权限，其他 = 可重试的错误 */
export function embedProblem(error: unknown): 'gone' | 'error' {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 403)
    ? 'gone'
    : 'error';
}
