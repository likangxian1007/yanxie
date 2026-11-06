import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ApiError,
  LIBRARY_ID_PREFIX,
  newId,
  ulid,
  type ActorRef,
  type AnyProjectEvent,
  type Paper,
  type PaperPublishInput,
  type PaperPublishResult,
  PAPER_PDF_MAX_BYTES,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  files,
  paperChunks,
  paperPublications,
  paperNotes,
  paperAnnotations,
  papers,
  projectMembers,
  projects,
} from '../../db/schema';
import { toFile } from '../files/service';
import { uniqueCitekey } from './bibtex';
import { libraryDiskPath } from './storage';
import { invalidateIndex } from './search';
import { toPaper } from './service';
import { flushNote, noteState } from './notes';
import { liveDocument } from '../../realtime/collab';
import { annotationMatches, flushAnnotation } from './annotations';
import { flushQaTurn } from './qa-records';
import { selectedQa, copyQa } from './qa-publication';
import { publicationTargets } from './publication-targets';

/** 同一事务提交完整副本与事件；磁盘文件用独立路径，失败时仅清理本次创建的文件。 */
export async function publishPaper(
  ctx: AppContext,
  actor: ActorRef & { id: string },
  sourcePaperId: string,
  input: PaperPublishInput,
): Promise<PaperPublishResult<Paper>> {
  let stagedPath: string | undefined;
  let committed = false;
  const selected = [...(input.notes ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(selected.map((n) => n.id)).size !== selected.length)
    throw new ApiError('bad_request', '不能重复选择同一笔记');
  const noteSelection = JSON.stringify(selected);
  const requestOptions = JSON.stringify(
    input.targetPaperId
      ? { targetPaperId: input.targetPaperId, targetUpdatedAt: input.targetUpdatedAt }
      : {},
  );
  if (Boolean(input.targetPaperId) !== Boolean(input.targetUpdatedAt))
    throw new ApiError('validation_failed', '追加需要选择项目论文及其预览版本');
  const selectedAnnotations = [...(input.annotations ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  if (new Set(selectedAnnotations.map((a) => a.id)).size !== selectedAnnotations.length)
    throw new ApiError('bad_request', '不能重复选择同一标注');
  const annotationSelection = JSON.stringify(selectedAnnotations);
  const selectedQuestions = [...(input.qa ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const qaSelection = JSON.stringify(selectedQuestions);
  // 重试先查凭据：个人原件删掉后仍能返回已提交结果。
  const [previousRequest] = await ctx.db.db
    .select()
    .from(paperPublications)
    .where(
      and(
        eq(paperPublications.publisherUserId, actor.id),
        eq(paperPublications.requestId, input.requestId),
      ),
    );
  if (!previousRequest) {
    for (const turn of selectedQuestions)
      await flushQaTurn(
        ctx,
        { kind: 'personal', ownerUserId: actor.id },
        sourcePaperId,
        turn.id,
        actor,
      );
    for (const note of selected) {
      await flushNote(
        ctx,
        { kind: 'personal', ownerUserId: actor.id },
        sourcePaperId,
        note.id,
        actor,
      );
    }
    for (const annotation of selectedAnnotations) {
      await flushAnnotation(
        ctx,
        { kind: 'personal', ownerUserId: actor.id },
        sourcePaperId,
        annotation.id,
        actor,
      );
    }
  }
  try {
    const outcome = await ctx.db.db.transaction(async (tx) => {
      const [member] = await tx
        .select()
        .from(projectMembers)
        .where(
          and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.userId, actor.id)),
        )
        .for('share');
      if (!member) throw new ApiError('not_found', '项目不存在或你不是成员');
      if (member.role === 'guest') throw new ApiError('forbidden', '发布论文需要项目写入权限');
      // 顺序与成员移除一致：先成员行，再项目行，避免互相等待。
      // 串行化同一项目的发布，并阻止发布期间项目被归档/删除。
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), isNull(projects.archivedAt)))
        .for('update');
      if (!project) throw new ApiError('not_found', '项目不存在或你不是成员');

      const [receipt] = await tx
        .select()
        .from(paperPublications)
        .where(
          and(
            eq(paperPublications.publisherUserId, actor.id),
            eq(paperPublications.requestId, input.requestId),
          ),
        );
      if (receipt) {
        if (
          receipt.projectId !== input.projectId ||
          receipt.sourcePaperId !== sourcePaperId ||
          receipt.sourceUpdatedAt.toISOString() !== input.sourceUpdatedAt ||
          receipt.noteSelection !== noteSelection ||
          receipt.annotationSelection !== annotationSelection ||
          receipt.qaSelection !== qaSelection ||
          receipt.requestOptions !== requestOptions
        )
          throw new ApiError('conflict', '这次发布编号已用于其他内容，请重新打开发布窗口');
        const [existing] = receipt.paperId
          ? await tx
              .select()
              .from(papers)
              .where(
                and(
                  eq(papers.id, receipt.paperId),
                  eq(papers.projectId, input.projectId),
                  eq(papers.space, 'team'),
                ),
              )
          : [];
        if (!existing)
          throw new ApiError(
            'conflict',
            '此前发布的项目副本已被删除；如需重新发布，请重新打开发布窗口',
          );
        return {
          result: {
            paper: toPaper(existing),
            replayed: true,
            ...(receipt.summary ? { summary: receipt.summary } : {}),
          },
          events: [] as AnyProjectEvent[],
        };
      }

      // 锁定源论文：复制期间不能替换 PDF、更新解析结果或删除原件。
      const [source] = await tx
        .select()
        .from(papers)
        .where(
          and(
            eq(papers.id, sourcePaperId),
            eq(papers.ownerUserId, actor.id),
            isNull(papers.projectId),
          ),
        )
        .for('update');
      if (!source) throw new ApiError('not_found', '个人论文不存在或已被删除');
      if (source.updatedAt.toISOString() !== input.sourceUpdatedAt)
        throw new ApiError('version_conflict', '个人论文已更新，请重新打开发布窗口核对内容');
      if (source.archivedAt) throw new ApiError('conflict', '请先恢复已归档的个人论文');
      if (['queued', 'fetching', 'parsing', 'indexing'].includes(source.status))
        throw new ApiError('conflict', '论文正在处理，请等处理完成后再发布');

      const selectedRows: (typeof paperNotes.$inferSelect)[] = [];
      for (const selection of selected) {
        const [note] = await tx
          .select()
          .from(paperNotes)
          .where(
            and(
              eq(paperNotes.id, selection.id),
              eq(paperNotes.paperId, source.id),
              isNull(paperNotes.deletedAt),
            ),
          )
          .for('update');
        if (!note) throw new ApiError('not_found', '所选笔记已删除或不属于这篇个人论文');
        const live = liveDocument(ctx, note.id);
        if (
          note.version !== selection.version ||
          (live && live.getText('body').toString() !== note.body)
        )
          throw new ApiError('version_conflict', '所选笔记在预览后发生变化，请重新预览再发布');
        selectedRows.push(note);
      }

      const annotationRows: (typeof paperAnnotations.$inferSelect)[] = [];
      for (const selection of selectedAnnotations) {
        const [annotation] = await tx
          .select()
          .from(paperAnnotations)
          .where(
            and(
              eq(paperAnnotations.id, selection.id),
              eq(paperAnnotations.paperId, source.id),
              isNull(paperAnnotations.deletedAt),
            ),
          )
          .for('update');
        if (!annotation) throw new ApiError('not_found', '所选标注已删除或不属于这篇个人论文');
        if (!annotationMatches(annotation, source))
          throw new ApiError(
            'version_conflict',
            '所选标注对应其他 PDF 版本，定位待确认，暂不能发布',
          );
        const live = liveDocument(ctx, annotation.id);
        if (
          annotation.version !== selection.version ||
          (live && live.getText('body').toString() !== annotation.body)
        )
          throw new ApiError(
            'version_conflict',
            '所选高亮或批注在预览后发生变化，请重新预览再发布',
          );
        annotationRows.push(annotation);
      }

      const targets = await publicationTargets(tx, source, input.projectId);
      const target = input.targetPaperId
        ? targets.find((t) => t.paper.id === input.targetPaperId)
        : undefined;
      if (input.targetPaperId && !target)
        throw new ApiError('conflict', '目标已删除或不再匹配这篇论文，请重新核对');
      if (target && (target.paper.archivedAt || target.paper.updatedAt !== input.targetUpdatedAt))
        throw new ApiError('version_conflict', '项目论文已变化或归档，请刷新候选并重新核对');
      if (!target && targets.length)
        throw new ApiError('conflict', '项目已有同论文候选，请明确选择追加目标', {
          existingPaperId: targets[0]!.paper.id,
          projectId: input.projectId,
        });
      if (target && !selected.length && !selectedAnnotations.length && !selectedQuestions.length)
        throw new ApiError('validation_failed', '请选择要追加的笔记、标注或问答');
      const wasPublished = (
        kind: 'notes' | 'annotations' | 'qa',
        row: { id: string; version: number },
      ) =>
        target?.published[kind].some((p) => p.id === row.id && p.version === row.version) ?? false;
      const newNotes = selectedRows.filter((r) => !wasPublished('notes', r));
      const newAnnotations = annotationRows.filter((r) => !wasPublished('annotations', r));
      if (target && newAnnotations.length && !target.samePdf)
        throw new ApiError(
          'conflict',
          '两份 PDF 版本不一致，不能追加高亮或批注。可改为发布说明稿；项目 PDF 不会被替换。',
        );
      const questions = (
        await selectedQa(
          ctx,
          tx,
          source,
          selectedQuestions,
          true,
          input.projectId,
          input.targetPaperId,
        )
      ).filter((q) => !wasPublished('qa', q.row));
      const summary = {
        mode: target ? ('appended' as const) : ('created' as const),
        added: { notes: newNotes.length, annotations: newAnnotations.length, qa: questions.length },
        skipped: {
          notes: selectedRows.length - newNotes.length,
          annotations: annotationRows.length - newAnnotations.length,
          qa: selectedQuestions.length - questions.length,
        },
      };
      const evs: AnyProjectEvent[] = [];
      let id = target?.paper.id ?? `${LIBRARY_ID_PREFIX.paper}_${ulid()}`;
      let fileId: string | null = target?.paper.fileId ?? null;
      let copy: typeof papers.$inferSelect | undefined;
      if (target) {
        [copy] = await tx.select().from(papers).where(eq(papers.id, target.paper.id)).for('update');
        if (!copy || copy.updatedAt.toISOString() !== input.targetUpdatedAt)
          throw new ApiError('version_conflict', '项目论文已变化，请重新核对');
      } else {
        const keys = await tx
          .select({ key: papers.citekey })
          .from(papers)
          .where(eq(papers.projectId, input.projectId));
        const citekey = uniqueCitekey(source.citekey, new Set(keys.map((p) => p.key)));
        id = `${LIBRARY_ID_PREFIX.paper}_${ulid()}`;
        if (source.fileId) {
          const [file] = await tx
            .select()
            .from(files)
            .where(
              and(
                eq(files.id, source.fileId),
                eq(files.ownerUserId, actor.id),
                isNull(files.projectId),
              ),
            );
          if (!file) throw new ApiError('conflict', '个人 PDF 不存在，请补传后重新发布');
          let bytes: Buffer;
          try {
            bytes = await readFile(
              libraryDiskPath(ctx, { kind: 'personal', ownerUserId: actor.id }, file.path),
            );
          } catch {
            throw new ApiError('conflict', '无法读取个人 PDF，请确认文件完整后重试');
          }
          if (
            bytes.length > PAPER_PDF_MAX_BYTES ||
            bytes.subarray(0, 5).toString('latin1') !== '%PDF-'
          )
            throw new ApiError('conflict', '个人 PDF 无效或超过 100 MB，请重新上传');
          if (
            source.pdfSha256 &&
            createHash('sha256').update(bytes).digest('hex') !== source.pdfSha256
          )
            throw new ApiError('conflict', '个人 PDF 内容已变化，请重新上传后再发布');
          fileId = newId('file');
          const name = `${citekey.replace(/[^a-zA-Z0-9_-]/gu, '_')}.pdf`;
          const path = `library/${fileId}/${name}`;
          stagedPath = libraryDiskPath(ctx, input.projectId, path);
          await mkdir(dirname(stagedPath), { recursive: true });
          await writeFile(stagedPath, bytes, { flag: 'wx' });
          const [copiedFile] = await tx
            .insert(files)
            .values({
              id: fileId,
              projectId: input.projectId,
              ownerUserId: null,
              name,
              path,
              mime: 'application/pdf',
              size: bytes.length,
              uploadedBy: actor,
            })
            .returning();
          evs.push(
            await ctx.bus.record(tx, {
              projectId: input.projectId,
              type: 'file.created',
              payload: toFile(copiedFile!),
              actor,
            }),
          );
        }
        // 白名单复制：不传播 note、任务错误、私人文件路径或其他个人阅读记录。
        const chunks = source.structure
          ? await tx.select().from(paperChunks).where(eq(paperChunks.paperId, source.id))
          : [];
        [copy] = await tx
          .insert(papers)
          .values({
            id,
            projectId: input.projectId,
            ownerUserId: null,
            title: source.title,
            authors: source.authors,
            year: source.year,
            venue: source.venue,
            abstract: source.abstract,
            doi: source.doi,
            arxivId: source.arxivId,
            url: source.url,
            pdfSha256: source.pdfSha256,
            citekey,
            tags: source.tags,
            source: source.source,
            fileId,
            status: source.structure ? 'ready' : fileId ? 'failed' : 'needs_pdf',
            progress: source.structure ? 100 : 0,
            error: source.structure
              ? null
              : fileId
                ? '尚无可用解析结果，可在项目库重新解析'
                : '本次仅发布论文信息，尚无 PDF',
            parser: source.structure ? source.parser : null,
            pageCount: source.pageCount,
            chunkCount: chunks.length,
            hasLatexSource: source.structure ? source.hasLatexSource : 0,
            structure: source.structure,
            meta: { ...source.meta, citekeyFixed: true },
            createdBy: actor,
          })
          .returning();
        // 控制单条 SQL 的参数量，避免长论文超过 PostgreSQL 的绑定参数上限。
        for (let offset = 0; offset < chunks.length; offset += 200) {
          await tx.insert(paperChunks).values(
            chunks.slice(offset, offset + 200).map((chunk) => ({
              ...chunk,
              id: `${id}:${chunk.seq}`,
              paperId: id,
              projectId: input.projectId,
            })),
          );
        }
      }
      await tx.insert(paperPublications).values({
        id: `pub_${ulid()}`,
        publisherUserId: actor.id,
        requestId: input.requestId,
        projectId: input.projectId,
        paperId: id,
        sourcePaperId: source.id,
        sourceFileId: source.fileId,
        sourceUpdatedAt: source.updatedAt,
        publishedBy: actor,
        noteSelection,
        annotationSelection,
        qaSelection,
        requestOptions,
        summary,
      });
      for (const sourceNote of newNotes) {
        await tx.insert(paperNotes).values({
          id: `lnt_${ulid()}`,
          paperId: id,
          title: sourceNote.title,
          kind: sourceNote.kind,
          body: sourceNote.body,
          ydocState: noteState(sourceNote.body),
          createdBy: actor,
          updatedBy: actor,
          publishedFrom: {
            author: sourceNote.createdBy,
            publishedBy: actor,
            publishedAt: new Date().toISOString(),
            sourceVersion: sourceNote.version,
          },
        });
      }
      for (const annotation of newAnnotations) {
        if (!fileId) throw new ApiError('conflict', '缺少团队 PDF 副本，无法发布标注');
        await tx.insert(paperAnnotations).values({
          id: `lan_${ulid()}`,
          paperId: id,
          kind: annotation.kind,
          color: annotation.color,
          label: annotation.label,
          fileId,
          pdfSha256: source.pdfSha256,
          page: annotation.page,
          quote: annotation.quote,
          boxes: annotation.boxes,
          body: annotation.body,
          ydocState: noteState(annotation.body),
          createdBy: actor,
          updatedBy: actor,
          publishedFrom: {
            author: annotation.createdBy,
            publishedBy: actor,
            publishedAt: new Date().toISOString(),
            sourceVersion: annotation.version,
          },
        });
      }
      await copyQa(tx, questions, copy!, actor);
      if (target) {
        if (newNotes.length)
          evs.push(
            await ctx.bus.record(tx, {
              projectId: input.projectId,
              type: 'paper.notes.changed',
              payload: { paperId: id, noteId: '', deleted: false },
              actor,
            }),
          );
        if (newAnnotations.length)
          evs.push(
            await ctx.bus.record(tx, {
              projectId: input.projectId,
              type: 'paper.annotations.changed',
              payload: { paperId: id, annotationId: '', deleted: false },
              actor,
            }),
          );
        if (questions.length)
          evs.push(
            await ctx.bus.record(tx, {
              projectId: input.projectId,
              type: 'paper.qa.changed',
              payload: { paperId: id, sessionId: '', turnId: null, deleted: false },
              actor,
            }),
          );
      }
      const paper = toPaper(copy!);
      evs.push(
        await ctx.bus.record(tx, {
          projectId: input.projectId,
          type: target ? 'paper.updated' : 'paper.created',
          payload: paper,
          actor,
        }),
      );
      return { result: { paper, replayed: false, summary }, events: evs };
    });
    committed = true;
    invalidateIndex(ctx, input.projectId);
    for (const event of outcome.events) ctx.bus.emit(event);
    return outcome.result;
  } catch (error) {
    const code =
      (error as { code?: string; cause?: { code?: string } }).code ??
      (error as { cause?: { code?: string } }).cause?.code;
    if (code === '23505')
      throw new ApiError('conflict', '项目中已有相同论文或发布请求，请重新核对项目文献库');
    throw error;
  } finally {
    if (!committed && stagedPath) await rm(stagedPath, { force: true }).catch(() => undefined);
  }
}
