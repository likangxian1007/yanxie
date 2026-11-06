import {
  ApiError,
  DocumentEdit,
  ProposalListQuery,
  VersionCreateInput,
  VersioningSettingsInput,
  VersionTargetQuery,
  type ActorRef,
} from '@srh/shared';
import { collab, registerCollabPort } from '../../agents/tools/collab-port';
import type { AppContext } from '../../context';
import { parse } from '../../lib/http';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { changeProposals, versions } from '../../db/schema';
import { notFound, requireProject, type Params } from '../collab-common';
import { accessOf, TEAM_VIEWER, type Viewer } from '../sharing/access';
import { loadResource, requireResource } from '../sharing/service';
import { getDocument } from '../documents/service';
import { applyEdit, toMarkdown } from '../documents/ydoc';
import { registerSnapshotProvider } from '../reviews/snapshot';
import type { ModuleDef } from '../types';
import { targetInfo } from './content';
import { testGithub } from './github';
import {
  closeProposal,
  getProposal,
  listProposals,
  mergeProposal,
  proposalNotice,
  proposalSnapshot,
  proposeEdit,
  setDecisions,
  shouldPropose,
  startReviewBridge,
} from './proposals';
import {
  createManualVersion,
  listVersions,
  readCurrentContent,
  readVersion,
  restoreVersion,
  startAutoSnapshots,
} from './service';
import { getSettings, updateSettings } from './settings';

/**
 * 版本管理（API.md §2.18）：
 *   GET    P/versions?targetKind=&targetId=          版本列表（新的在前）
 *   POST   P/versions                                 手动存为版本 { targetKind, targetId, note }
 *   GET    P/versions/current?targetKind=&targetId=   当前内容的可读表示（和版本对比用）
 *   GET    P/versions/:versionId                      版本内容
 *   POST   P/versions/:versionId/restore              回滚（回滚前备份 + 回滚结果都存成版本）
 *   GET    P/proposals?targetKind=&targetId=&status=  改动提案列表
 *   GET    P/proposals/:id                            提案详情（含当前冲突）
 *   PATCH  P/proposals/:id/decisions                  逐条接受 / 拒绝 { decisions: { hunkId: accepted|rejected|pending } }
 *   POST   P/proposals/:id/merge                      合入 { acceptPending, skipConflicts, lgtm }
 *   POST   P/proposals/:id/close                      不合入，关闭
 *   GET    P/versioning/settings                      项目版本设置
 *   PATCH  P/versioning/settings                      修改（负责人 / 导师）
 *   POST   P/versioning/github/test                   测试 GitHub 仓库连接（负责人 / 导师）
 */
const P = '/projects/:projectId';

/** agent 写文档：需要时改成改动提案 */
async function agentDocumentEdit(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  docId: string,
  edit: unknown,
  reason: string | undefined,
  viewer: Viewer,
  direct: (
    edit: never,
  ) => Promise<{ meta: Awaited<ReturnType<typeof getDocument>>; markdown: string }>,
) {
  // 先按 agent 代表的人检查文档权限（提案也是写入，不能绕过个人空间）
  const res = await loadResource(ctx, 'document', docId);
  const level = res && res.projectId === projectId ? await accessOf(ctx, res, viewer) : 'none';
  if (level === 'none') throw new ApiError('not_found', '文档不存在，或你没有访问权限');
  if (level !== 'edit' && level !== 'manage') {
    throw new ApiError('forbidden', '只有阅读或评论权限，不能修改这篇文档');
  }
  const info = await targetInfo(ctx, projectId, 'document', docId);
  if (!(await shouldPropose(ctx, actor, info))) return direct(edit as never);
  if (info.archived) throw new ApiError('conflict', '文档已归档，恢复后才能修改');
  const parsed = DocumentEdit.parse(edit);
  const kind = info.docKind ?? 'doc';
  const { proposal, draft, created } = await proposeEdit(
    ctx,
    actor,
    info,
    (d) => applyEdit(d, kind, parsed),
    { explanation: reason },
  );
  const markdown = toMarkdown(draft, kind);
  draft.destroy();
  return {
    meta: await getDocument(ctx, projectId, docId),
    markdown,
    notice: proposalNotice(proposal, created),
    proposalId: proposal.id,
  };
}

/**
 * 版本 / 提案的权限跟着它的对象走：文档按文档权限（个人空间的文档只有能看到它的人能看历史、
 * 只有可编辑的人能存版本、回滚、处理提案），notebook / 文件按项目角色。
 */
async function guardTarget(
  req: FastifyRequest,
  projectId: string,
  kind: string,
  id: string,
  need: 'view' | 'edit',
): Promise<{ actor: ActorRef }> {
  if (kind === 'document') return requireResource(req, projectId, 'document', id, need);
  return requireProject(req, projectId, need === 'view' ? 'view' : 'write');
}

async function versionTarget(ctx: AppContext, projectId: string, versionId: string) {
  const [row] = await ctx.db.db
    .select({ kind: versions.targetKind, id: versions.targetId })
    .from(versions)
    .where(and(eq(versions.id, versionId), eq(versions.projectId, projectId)));
  if (!row) notFound('版本');
  return row;
}

async function proposalTarget(ctx: AppContext, projectId: string, proposalId: string) {
  const [row] = await ctx.db.db
    .select({ kind: changeProposals.targetKind, id: changeProposals.targetId })
    .from(changeProposals)
    .where(and(eq(changeProposals.id, proposalId), eq(changeProposals.projectId, projectId)));
  if (!row) notFound('改动提案');
  return row;
}

/** 列表里去掉看不到的文档的提案 */
async function visibleProposals<T extends { targetKind: string; targetId: string }>(
  ctx: AppContext,
  list: T[],
  viewer: Viewer,
): Promise<T[]> {
  const seen = new Map<string, boolean>();
  const out: T[] = [];
  for (const p of list) {
    if (p.targetKind !== 'document') {
      out.push(p);
      continue;
    }
    let ok = seen.get(p.targetId);
    if (ok === undefined) {
      const res = await loadResource(ctx, 'document', p.targetId);
      ok = !!res && (await accessOf(ctx, res, viewer)) !== 'none';
      seen.set(p.targetId, ok);
    }
    if (ok) out.push(p);
  }
  return out;
}

type VersionParams = Params<'projectId' | 'versionId'>;
type ProposalParams = Params<'projectId' | 'proposalId'>;

export const versioningModule: ModuleDef = {
  name: 'versioning',
  owner: 'collab',
  register(app) {
    const ctx = app.ctx;
    startAutoSnapshots(ctx);
    startReviewBridge(ctx);
    registerSnapshotProvider('proposal', proposalSnapshot);

    // agent 改文档默认走改动提案：包一层 documents 模块注册的写入端口
    const docs = collab('documents');
    if (docs) {
      registerCollabPort({
        documents: {
          ...docs,
          applyEdit: (c, actor, pid, docId, edit, opts) =>
            agentDocumentEdit(
              c,
              actor,
              pid,
              docId,
              edit,
              opts?.reason,
              opts?.viewer ?? TEAM_VIEWER,
              (e) => docs.applyEdit(c, actor, pid, docId, e, opts),
            ),
        },
      });
    }

    // ------------------------------------------------------------ 历史版本
    app.get<{ Params: Params<'projectId'> }>(`${P}/versions`, async (req) => {
      const { projectId } = req.params;
      const q = parse(VersionTargetQuery, req.query);
      await guardTarget(req, projectId, q.targetKind, q.targetId, 'view');
      return listVersions(ctx, projectId, q.targetKind, q.targetId);
    });

    app.get<{ Params: Params<'projectId'> }>(`${P}/versions/current`, async (req) => {
      const { projectId } = req.params;
      const q = parse(VersionTargetQuery, req.query);
      await guardTarget(req, projectId, q.targetKind, q.targetId, 'view');
      return readCurrentContent(ctx, projectId, q.targetKind, q.targetId);
    });

    app.post<{ Params: Params<'projectId'> }>(`${P}/versions`, async (req, reply) => {
      const { projectId } = req.params;
      const input = parse(VersionCreateInput, req.body ?? {});
      const { actor } = await guardTarget(req, projectId, input.targetKind, input.targetId, 'edit');
      return reply
        .status(201)
        .send(
          await createManualVersion(
            ctx,
            actor,
            projectId,
            input.targetKind,
            input.targetId,
            input.note,
          ),
        );
    });

    app.get<{ Params: VersionParams }>(`${P}/versions/:versionId`, async (req) => {
      const { projectId, versionId } = req.params;
      await requireProject(req, projectId, 'view');
      const t = await versionTarget(ctx, projectId, versionId);
      await guardTarget(req, projectId, t.kind, t.id, 'view');
      return readVersion(ctx, projectId, versionId);
    });

    app.post<{ Params: VersionParams }>(`${P}/versions/:versionId/restore`, async (req) => {
      const { projectId, versionId } = req.params;
      await requireProject(req, projectId, 'view');
      const t = await versionTarget(ctx, projectId, versionId);
      const { actor } = await guardTarget(req, projectId, t.kind, t.id, 'edit');
      return restoreVersion(ctx, actor, projectId, versionId);
    });

    // ------------------------------------------------------------ 改动提案
    app.get<{ Params: Params<'projectId'> }>(`${P}/proposals`, async (req) => {
      const { projectId } = req.params;
      const { user, role } = await requireProject(req, projectId, 'view');
      const q = parse(ProposalListQuery, req.query);
      if (q.targetKind && q.targetId) {
        await guardTarget(req, projectId, q.targetKind, q.targetId, 'view');
        return listProposals(ctx, projectId, q);
      }
      return visibleProposals(ctx, await listProposals(ctx, projectId, q), {
        userId: user.id,
        role,
      });
    });

    app.get<{ Params: ProposalParams }>(`${P}/proposals/:proposalId`, async (req) => {
      const { projectId, proposalId } = req.params;
      await requireProject(req, projectId, 'view');
      const t = await proposalTarget(ctx, projectId, proposalId);
      await guardTarget(req, projectId, t.kind, t.id, 'view');
      return getProposal(ctx, projectId, proposalId);
    });

    app.patch<{ Params: ProposalParams }>(`${P}/proposals/:proposalId/decisions`, async (req) => {
      const { projectId, proposalId } = req.params;
      await requireProject(req, projectId, 'view');
      const t = await proposalTarget(ctx, projectId, proposalId);
      const { actor } = await guardTarget(req, projectId, t.kind, t.id, 'edit');
      return setDecisions(ctx, actor, projectId, proposalId, req.body ?? {});
    });

    app.post<{ Params: ProposalParams }>(`${P}/proposals/:proposalId/merge`, async (req) => {
      const { projectId, proposalId } = req.params;
      await requireProject(req, projectId, 'view');
      const t = await proposalTarget(ctx, projectId, proposalId);
      const { actor } = await guardTarget(req, projectId, t.kind, t.id, 'edit');
      return mergeProposal(ctx, actor, projectId, proposalId, req.body ?? {});
    });

    app.post<{ Params: ProposalParams }>(`${P}/proposals/:proposalId/close`, async (req) => {
      const { projectId, proposalId } = req.params;
      await requireProject(req, projectId, 'view');
      const t = await proposalTarget(ctx, projectId, proposalId);
      const { actor } = await guardTarget(req, projectId, t.kind, t.id, 'edit');
      return closeProposal(ctx, actor, projectId, proposalId);
    });

    // ------------------------------------------------------------ 设置
    app.get<{ Params: Params<'projectId'> }>(`${P}/versioning/settings`, async (req) => {
      const { projectId } = req.params;
      await requireProject(req, projectId, 'view');
      return getSettings(ctx, projectId);
    });

    app.patch<{ Params: Params<'projectId'> }>(`${P}/versioning/settings`, async (req) => {
      const { projectId } = req.params;
      const { actor } = await requireProject(req, projectId, 'manage');
      return updateSettings(ctx, actor, projectId, parse(VersioningSettingsInput, req.body ?? {}));
    });

    app.post<{ Params: Params<'projectId'> }>(`${P}/versioning/github/test`, async (req) => {
      const { projectId } = req.params;
      await requireProject(req, projectId, 'manage');
      return testGithub(ctx, projectId);
    });
  },
};
