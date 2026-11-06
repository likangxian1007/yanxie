import type { z } from 'zod';
import type {
  ActorRef,
  Board,
  Card,
  CardCreateInput,
  CardUpdateInput,
  DocumentCreateInput,
  DocumentMeta,
  Experiment,
  ProjectRole,
  ExperimentCreateInput,
  ExperimentLog,
  ExperimentLogCreateInput,
  ExperimentUpdateInput,
  Report,
  ReportCreateInput,
  Review,
  ReviewCreateInput,
  Todo,
  TodoCreateInput,
} from '@srh/shared';
import type { AppContext } from '../../context';

/**
 * agent 工具层调用协作模块的端口（后端线程定义，协作线程实现并注册）。
 *
 * 协作模块在自己的 register() 里调用 registerCollabPort({ documents: {...} })；
 * 没注册的部分，对应工具不会出现在 agent 的工具列表（{{tool_list}}）里，模型也就不会去调。
 * 约定：actor 是发起操作的 agent（或人）；实现内部照常写库 + bus.publish；错误抛 ApiError。
 * 认领写入守卫（ARCHITECTURE.md §5.3.6）在工具层做，实现方不需要检查认领。
 */

type In<T extends z.ZodType> = z.input<T>;

/** 文档类型（协作线程扩展：doc 正文 / sheet 表格 / slides 幻灯片 / latex 源码） */
export type DocumentKindName = 'doc' | 'sheet' | 'slides' | 'latex';

export interface DocumentOutlineItem {
  heading: string;
  level: number;
}

export type AgentDocEdit =
  | { op: 'append'; markdown: string }
  | { op: 'insert_after_heading'; heading: string; markdown: string }
  | { op: 'replace_section'; heading: string; markdown: string }
  | { op: 'replace_text'; find: string; replace: string; occurrence?: number }
  | { op: 'set_cells'; sheet?: string; cells: { ref: string; value: string }[] }
  | {
      op: 'append_slides' | 'replace_slides';
      slides: {
        title: string;
        body: string;
        layout?: 'title' | 'content' | 'two-column' | 'section';
      }[];
    };

/**
 * agent 代表谁看文档：个人会话 = 发起的成员（userId + 角色），协调者 / 团队线程 = 只看团队空间
 * （userId 为 null）。不传 = 团队视角。和 modules/sharing/access.ts 的 Viewer 同形。
 */
export interface PortViewer {
  userId: string | null;
  role: ProjectRole | null;
}

export interface DocumentsPort {
  list(
    ctx: AppContext,
    projectId: string,
    viewer?: PortViewer,
  ): Promise<(DocumentMeta & { kind?: DocumentKindName })[]>;
  read(
    ctx: AppContext,
    projectId: string,
    docId: string,
    viewer?: PortViewer,
  ): Promise<{
    meta: DocumentMeta & { kind?: DocumentKindName };
    markdown: string;
    outline: DocumentOutlineItem[];
  }>;
  create(
    ctx: AppContext,
    actor: ActorRef,
    projectId: string,
    input: In<typeof DocumentCreateInput> & { kind?: DocumentKindName },
    viewer?: PortViewer,
  ): Promise<DocumentMeta>;
  applyEdit(
    ctx: AppContext,
    actor: ActorRef,
    projectId: string,
    docId: string,
    edit: AgentDocEdit,
    /** reason：改动理由，生成改动提案时作为说明 */
    opts?: { reason?: string; viewer?: PortViewer },
    /** notice / proposalId：版本管理把这次修改存成了改动提案（正文未变） */
  ): Promise<{ meta: DocumentMeta; markdown: string; notice?: string; proposalId?: string }>;
}

export interface ExperimentsPort {
  list(ctx: AppContext, projectId: string): Promise<Experiment[]>;
  get(
    ctx: AppContext,
    projectId: string,
    id: string,
  ): Promise<Experiment & { logs: ExperimentLog[] }>;
  create(
    ctx: AppContext,
    actor: ActorRef,
    projectId: string,
    input: In<typeof ExperimentCreateInput>,
  ): Promise<Experiment>;
  update(
    ctx: AppContext,
    actor: ActorRef,
    projectId: string,
    id: string,
    input: In<typeof ExperimentUpdateInput>,
  ): Promise<Experiment>;
  log(
    ctx: AppContext,
    actor: ActorRef,
    projectId: string,
    id: string,
    input: In<typeof ExperimentLogCreateInput>,
  ): Promise<ExperimentLog>;
}

export interface BoardsPort {
  createCard(
    ctx: AppContext,
    actor: ActorRef,
    projectId: string,
    input: Partial<In<typeof CardCreateInput>> & { title: string; boardId?: string },
  ): Promise<Card>;
  updateCard(
    ctx: AppContext,
    actor: ActorRef,
    projectId: string,
    cardId: string,
    input: In<typeof CardUpdateInput>,
  ): Promise<Card>;
  ensureDefaultBoard(ctx: AppContext, actor: ActorRef, projectId: string): Promise<Board>;
}

export interface TodosPort {
  create(
    ctx: AppContext,
    actor: ActorRef,
    projectId: string,
    input: In<typeof TodoCreateInput>,
  ): Promise<Todo>;
}

export interface ReviewsPort {
  create(
    ctx: AppContext,
    actor: ActorRef,
    projectId: string,
    input: In<typeof ReviewCreateInput> & { threadId?: string },
  ): Promise<Review>;
  /** 关闭一条审阅（重新送审时关掉被取代的旧审阅）；协作模块注册 closeReview */
  close?(ctx: AppContext, actor: ActorRef, projectId: string, reviewId: string): Promise<Review>;
}

export interface ReportsPort {
  draft(
    ctx: AppContext,
    actor: ActorRef,
    projectId: string,
    input: In<typeof ReportCreateInput>,
  ): Promise<Report>;
}

export interface SearchPort {
  searchDocuments(
    ctx: AppContext,
    projectId: string,
    query: string,
    viewer?: PortViewer,
  ): Promise<{ id: string; title: string; snippet: string }[]>;
}

export interface CollabPort {
  documents: DocumentsPort;
  /** @deprecated 实验能力已移除，此端口不再注册。 */
  experiments: ExperimentsPort;
  boards: BoardsPort;
  todos: TodosPort;
  reviews: ReviewsPort;
  reports: ReportsPort;
  search: SearchPort;
}

const port: Partial<CollabPort> = {};

/** 协作模块注册实现（可分多次调用，后注册的覆盖同名部分） */
export function registerCollabPort(partial: Partial<CollabPort>): void {
  Object.assign(port, partial);
}

/** 读取已注册的实现；没注册返回 undefined */
export function collab<K extends keyof CollabPort>(key: K): CollabPort[K] | undefined {
  return port[key];
}

/** 测试用：清空注册 */
export function resetCollabPort(): void {
  for (const key of Object.keys(port) as (keyof CollabPort)[]) delete port[key];
}
