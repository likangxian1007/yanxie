import type { DocumentMeta, DocumentOutlineItem } from '@srh/shared';
import type { CollabDoc } from '../collab/useCollabDoc';

/**
 * 四类编辑器（富文本、表格、幻灯片、LaTeX）的统一入参。
 * 文档详情页（DocDetailPage）负责：页头（标题、在线成员、连接状态、版本、导出）、建立协同连接；
 * 编辑器负责：自己的工具栏、正文区、内嵌 AI，并铺满父容器（父容器是 flex 列、min-h-0）。
 */
export interface DocEditorProps {
  projectId: string;
  docId: string;
  meta: DocumentMeta;
  /** 已建立的协同连接（Y.Doc + Hocuspocus provider + awareness 成员） */
  collab: CollabDoc;
  /** false = 只读（访客、或已归档） */
  editable: boolean;
  /**
   * 只读时还能不能评论（个人文档分享为「可评论」，§2.19）。不传 = 跟 editable 一致。
   * 目前富文本支持；其它编辑器忽略。
   */
  canComment?: boolean;
  /** 大纲变化时回调（详情页左侧大纲栏用） */
  onOutline?: (items: DocumentOutlineItem[]) => void;
  /** 详情页大纲点击后请求跳到第 index 个大纲项 */
  jumpTo?: { index: number; nonce: number } | null;
}
