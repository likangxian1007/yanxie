import { and, eq, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  ApiError,
  parseCitationMarkers,
  ulid,
  type ActorRef,
  type PaperQaPublishPreview,
  type PaperQaPublishSelection,
  type PaperQaSource,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  paperQaSessions,
  paperQaTurns,
  paperQaRevisions,
  paperPublications,
  paperChunks,
  papers,
} from '../../db/schema';
import { liveDocument } from '../../realtime/collab';
import { flushQaTurn, qaState, type QaTx, type QaRow } from './qa-records';
import { getPaperRow } from './service';
import { publicationTargets } from './publication-targets';

type PreviewTurn = PaperQaPublishPreview['turns'][number];
type Selected = { row: QaRow; preview: PreviewTurn };
const matches = (s: PaperQaSource, m: ReturnType<typeof parseCitationMarkers>[number]) =>
  (!m.citekey || s.citekey === m.citekey) &&
  s.page === m.page &&
  (m.para === null || s.para === m.para);
/** 清理已知内部资源 ID、个人库链接、本地文件路径；不声称能识别正文中的所有秘密。 */
export function sanitizeQaPublication(text: string) {
  let count = 0;
  const cleaned = text.replace(
    /(?:https?:\/\/[^\s)<>"']+)?\/(?:api\/v1\/)?(?:library|my\/library|files\/personal)\/[^\s)<>"']+|file:\/\/[^\s)<>"']+|[A-Za-z]:[\\/][^\n)<>"']+|\b(?:ppr|fil|lqt|lqs|lnt|lan|lqc)_[0-9A-Z]{26}\b/gu,
    () => {
      count++;
      return '（个人资源链接已移除）';
    },
  );
  return { text: cleaned, count };
}
export async function selectedQa(
  ctx: AppContext,
  tx: QaTx,
  source: typeof papers.$inferSelect,
  selections: PaperQaPublishSelection[],
  enforce: boolean,
  projectId: string,
  targetPaperId?: string,
): Promise<Selected[]> {
  const destination = targetPaperId
    ? (await publicationTargets(tx, source, projectId)).find((t) => t.paper.id === targetPaperId)
    : undefined;
  if (targetPaperId && (!destination || destination.paper.archivedAt))
    throw new ApiError('conflict', '追加目标已变化，请重新选择');
  if (new Set(selections.map((s) => s.id)).size !== selections.length)
    throw new ApiError('validation_failed', '不能重复选择问答');
  const rows: { row: QaRow; title: string; selection: PaperQaPublishSelection }[] = [];
  for (const selection of selections) {
    const [item] = await tx
      .select({ row: paperQaTurns, title: paperQaSessions.title })
      .from(paperQaTurns)
      .innerJoin(paperQaSessions, eq(paperQaSessions.id, paperQaTurns.sessionId))
      .where(
        and(
          eq(paperQaTurns.id, selection.id),
          eq(paperQaTurns.paperId, source.id),
          isNull(paperQaSessions.deletedAt),
        ),
      )
      .for('update');
    if (!item) throw new ApiError('not_found', '所选问答不存在或不属于这篇论文');
    const live = liveDocument(ctx, item.row.id);
    if (item.row.status !== 'done') throw new ApiError('conflict', '只能发布已完成的问答');
    if (
      item.row.version !== selection.version ||
      (live &&
        (live.getText('question').toString() !== item.row.question ||
          live.getText('answer').toString() !== item.row.answer))
    )
      throw new ApiError('version_conflict', '问答在预览后有修改，请重新预览');
    rows.push({ ...item, selection });
  }
  const shared = new Map<string, PaperQaSource>();
  for (const { row } of rows)
    for (const ref of row.sources) {
      if (
        destination &&
        destination.samePdf &&
        ref.paperId === source.id &&
        ref.fileId === source.fileId &&
        ref.pdfSha256 === source.pdfSha256
      ) {
        const [chunk] = await tx
          .select()
          .from(paperChunks)
          .where(
            and(
              eq(paperChunks.paperId, destination.paper.id),
              eq(paperChunks.page, ref.page),
              eq(paperChunks.para, ref.para),
            ),
          );
        if (chunk && ref.quote && chunk.text.slice(0, ref.quote.length) === ref.quote)
          shared.set(ref.id, {
            ...ref,
            paperId: destination.paper.id,
            fileId: destination.paper.fileId,
            chunkId: chunk.id,
            seq: chunk.seq,
            boxes: chunk.boxes,
          });
      }
      if (
        !ref.paperId ||
        ref.paperId === source.id ||
        !ref.fileId ||
        !ref.pdfSha256 ||
        ref.status !== 'available'
      )
        continue;
      const candidates = await tx
        .select({ paper: papers })
        .from(paperPublications)
        .innerJoin(papers, eq(papers.id, paperPublications.paperId))
        .where(
          and(
            eq(paperPublications.projectId, projectId),
            eq(paperPublications.sourcePaperId, ref.paperId),
            eq(paperPublications.sourceFileId, ref.fileId),
            eq(papers.projectId, projectId),
            eq(papers.space, 'team'),
            isNull(papers.ownerUserId),
            eq(papers.pdfSha256, ref.pdfSha256),
            isNull(papers.archivedAt),
          ),
        );
      const target = candidates.find((c) => Boolean(c.paper.fileId))?.paper;
      if (!target) continue;
      const [chunk] = await tx
        .select()
        .from(paperChunks)
        .where(
          and(
            eq(paperChunks.paperId, target.id),
            eq(paperChunks.page, ref.page),
            eq(paperChunks.para, ref.para),
          ),
        );
      if (!chunk || !ref.quote || chunk.text.slice(0, ref.quote.length) !== ref.quote) continue;
      shared.set(ref.id, {
        ...ref,
        paperId: target.id,
        fileId: target.fileId,
        chunkId: chunk.id,
        seq: chunk.seq,
        boxes: chunk.boxes,
      });
    }
  return rows.map(({ row, title, selection }) => {
    const missingContext = row.context
      .filter(
        (c) =>
          !rows.some((r) => r.row.id === c.turnId && r.row.version === c.version) ||
          destination?.published.qa.some((p) => p.id === c.turnId && p.version === c.version),
      )
      .map((c) => ({ id: c.turnId, version: c.version, question: c.question }));
    if (enforce && (missingContext.length || row.contextOmitted) && !selection.allowMissingContext)
      throw new ApiError(
        'validation_failed',
        '这条回答依赖未选中的历史问答，请补选、制作独立说明稿，或确认上下文不完整后发布',
      );
    const used = new Map<string, PaperQaSource>();
    const unshared = new Map<string, { id: string; title: string }>();
    const transform = (text: string) => {
      let out = '',
        last = 0;
      for (const marker of parseCitationMarkers(text)) {
        out += text.slice(last, marker.start);
        const ref = row.sources.find((s) => matches(s, marker));
        const available =
          !destination &&
          ref?.status === 'available' &&
          Boolean(source.fileId) &&
          ref.paperId === source.id &&
          ref.fileId === source.fileId &&
          ref.pdfSha256 === source.pdfSha256;
        const mapped = ref ? shared.get(ref.id) : undefined;
        if ((available || mapped) && ref) {
          used.set(ref.id, mapped ?? ref);
          out += marker.raw;
        } else {
          const key = ref?.id ?? marker.raw;
          unshared.set(key, { id: key, title: ref?.paperTitle ?? '未核实的引用' });
          if (selection.unsharedSources === 'mark') {
            out += `${marker.raw}（来源未共享）`;
            if (ref)
              used.set(ref.id, {
                ...ref,
                paperId: null,
                fileId: null,
                pdfSha256: null,
                chunkId: null,
                boxes: [],
                quote: '',
                status: 'unshared',
              });
          }
        }
        last = marker.end;
      }
      return sanitizeQaPublication(out + text.slice(last));
    };
    const q = transform(row.question),
      a = transform(row.answer);
    const selectionMatches =
      row.selection?.status === 'available' &&
      row.selection.fileId === source.fileId &&
      row.selection.pdfSha256 === source.pdfSha256 &&
      (!destination || destination.samePdf);
    const selectedQuote = row.selection
      ? selectionMatches
        ? {
            ...row.selection,
            text: sanitizeQaPublication(row.selection.text).text,
            fileId: destination?.paper.fileId ?? row.selection.fileId,
          }
        : selection.unsharedSources === 'remove'
          ? null
          : {
              ...row.selection,
              fileId: null,
              pdfSha256: null,
              status: 'unshared' as const,
              text: sanitizeQaPublication(row.selection.text).text,
            }
      : null;
    const previewHash = createHash('sha256')
      .update(
        JSON.stringify({
          id: row.id,
          version: row.version,
          projectId,
          question: q.text,
          answer: a.text,
          sources: [...used.values()],
          missingContext,
          selection: selectedQuote,
          targetPaperId: targetPaperId ?? null,
        }),
      )
      .digest('hex');
    if (enforce && selection.previewHash !== previewHash)
      throw new ApiError('version_conflict', '问答或引用状态与预览不同，请重新预览再发布');
    return {
      row,
      preview: {
        id: row.id,
        version: row.version,
        sessionTitle: title,
        question: q.text,
        answer: a.text,
        sources: [...used.values()],
        author: row.createdBy,
        missingContext,
        unsharedSources: [...unshared.values()],
        privateLinksRemoved: Boolean(q.count + a.count),
        previewHash,
        selection: selectedQuote,
      },
    };
  });
}
export async function previewQa(
  ctx: AppContext,
  actor: ActorRef & { id: string },
  paperId: string,
  selections: PaperQaPublishSelection[],
  projectId: string,
  targetPaperId?: string,
) {
  const scope = { kind: 'personal' as const, ownerUserId: actor.id };
  for (const s of selections) await flushQaTurn(ctx, scope, paperId, s.id, actor);
  const source = await getPaperRow(ctx, scope, paperId);
  return ctx.db.db.transaction(async (tx) => ({
    turns: (await selectedQa(ctx, tx, source, selections, false, projectId, targetPaperId)).map(
      (x) => x.preview,
    ),
  }));
}
export async function copyQa(
  tx: QaTx,
  selected: Selected[],
  paper: typeof papers.$inferSelect,
  actor: ActorRef & { id: string },
) {
  const sessions = new Map<string, string>(),
    ids = new Map(selected.map((x) => [x.row.id, `lqt_${ulid()}`]));
  for (const { row, preview } of selected) {
    let sessionId = sessions.get(row.sessionId);
    if (!sessionId) {
      sessionId = `lqs_${ulid()}`;
      sessions.set(row.sessionId, sessionId);
      await tx.insert(paperQaSessions).values({
        id: sessionId,
        paperId: paper.id,
        title: '已发布问答',
        createdBy: actor,
        updatedBy: actor,
      });
    }
    const id = ids.get(row.id)!;
    const context = row.context.flatMap((c) => {
      const target = selected.find((t) => t.row.id === c.turnId && t.row.version === c.version);
      return target
        ? [
            {
              turnId: ids.get(c.turnId)!,
              version: 1,
              question: target.preview.question.slice(0, 1500),
              answer: target.preview.answer.slice(0, 1500),
            },
          ]
        : [];
    });
    const sources = preview.sources.map((s) => ({
      ...s,
      id: `lqc_${ulid()}`,
      ...(s.status === 'available'
        ? s.paperId === row.paperId
          ? { paperId: paper.id, fileId: paper.fileId, chunkId: `${paper.id}:${s.seq}` }
          : { paperId: s.paperId, fileId: s.fileId, chunkId: s.chunkId }
        : { paperId: null, fileId: null, chunkId: null }),
    }));
    await tx.insert(paperQaTurns).values({
      id,
      sessionId,
      paperId: paper.id,
      generationId: `lqj_${ulid()}`,
      requestId: ulid(),
      requestSignature: 'published',
      requestedByUserId: actor.id,
      question: preview.question,
      answer: preview.answer,
      originalQuestion: preview.question,
      originalAnswer: preview.answer,
      origin: 'published',
      status: 'done',
      modelId: null,
      modelName: '发布副本',
      searchScope: row.searchScope,
      sources,
      context,
      selection: preview.selection
        ? {
            ...preview.selection,
            fileId: preview.selection.status === 'available' ? paper.fileId : null,
          }
        : null,
      contextOmitted: Boolean(preview.missingContext.length || row.contextOmitted),
      ydocState: qaState(preview.question, preview.answer),
      createdBy: actor,
      updatedBy: actor,
      completedAt: new Date(),
      publishedFrom: {
        author: row.createdBy,
        publishedBy: actor,
        publishedAt: new Date().toISOString(),
        sourceVersion: row.version,
      },
    });
    await tx.insert(paperQaRevisions).values({
      id: `lqr_${ulid()}`,
      turnId: id,
      version: 1,
      question: preview.question,
      answer: preview.answer,
      kind: 'published',
      actor,
    });
  }
}
