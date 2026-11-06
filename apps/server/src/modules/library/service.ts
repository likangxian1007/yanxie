import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { and, asc, desc, eq, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import {
  ApiError,
  LIBRARY_ID_PREFIX,
  arxivIdFromDoi,
  normalizeArxivId,
  ulid,
  normalizeDoi,
  type ActorRef,
  type Paper,
  type PaperDetail,
  type PaperListQuery,
  type PaperSource,
  type PaperUpdateWithVersionsInput,
  type ProjectRole,
  type ResourceSpace,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  paperChunks,
  papers,
  paperNotes,
  paperAnnotations,
  paperQaTurns,
  projects,
} from '../../db/schema';
import { abortQaTurns } from './qa-jobs';
import { closeDocumentConnections } from '../../realtime/collab';
import type { PaperBibMeta } from '../../db/schema/library';
import { deleteLibraryFile, getLibraryFile, writeLibraryPdf, libraryDiskPath } from './storage';
import { libraryScope, scopeOf, scopeValues, scopeWhere, type LibraryScopeInput } from './scope';
import { accessMap, sharedIds, TEAM_VIEWER, visibleWhere, type Viewer } from '../sharing/access';
import { clearSharing, notifySpaceChanged } from '../sharing/service';
import { clearPersonalAudience, setPersonalAudience } from '../../realtime/audience';
import { baseCitekey, toBibtex, uniqueCitekey } from './bibtex';
import { invalidateIndex } from './search';

/**
 * 文献库的数据层：论文的增删改查、导入去重、引用键分配、事件发布。
 * 解析流水线在 pipeline.ts，排队在 queue.ts。
 */
export type PaperRow = typeof papers.$inferSelect;

/** 解析流水线写入时的身份 */
export const LIBRARY_ACTOR: ActorRef = { kind: 'system', id: null, name: '文献库' };

/** 论文 PDF 在项目共享文件夹里的目录 */
export const LIBRARY_DIR = 'library';

export function paperPdfId(row: {
  fileId: string | null;
  pdfSha256: string | null;
  privatePdfPath?: string | null;
}): string | null {
  return (
    row.fileId ?? (row.privatePdfPath ? `private:${(row.pdfSha256 ?? '').slice(0, 12)}` : null)
  );
}

export function toPaper(row: PaperRow): Paper {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    authors: row.authors,
    year: row.year,
    venue: row.venue,
    abstract: row.abstract,
    doi: row.doi,
    arxivId: row.arxivId,
    url: row.url,
    citekey: row.citekey,
    tags: row.tags,
    note: row.note,
    noteVersion: row.noteVersion,
    titleVersion: row.titleVersion,
    tagsVersion: row.tagsVersion,
    source: row.source,
    status: row.status,
    progress: row.progress,
    stage: row.stage,
    error: row.error,
    parser: row.parser,
    // 个人文献的 PDF 不在项目共享文件夹里（没有文件 id）：给一个占位 id，前端据此知道有 PDF
    fileId: paperPdfId(row),
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    hasLatexSource: row.hasLatexSource === 1,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    space: row.projectId ? row.space : 'personal',
    ownerUserId: row.ownerUserId,
  };
}

/** 同一个「库」：团队文献库，或某人的个人文献（去重、引用键唯一都按库算） */
function sameLibrary(owner: string | null): SQL {
  return owner ? eq(papers.ownerUserId, owner) : isNull(papers.ownerUserId);
}

/** REST 响应里标上当前用户的权限，所有者的个人文献标上是否已分享 */
export async function annotatePapers(
  ctx: AppContext,
  list: Paper[],
  viewer: Viewer,
): Promise<Paper[]> {
  const rows = list.map((p) => ({
    id: p.id,
    space: p.space ?? 'team',
    ownerUserId: p.ownerUserId ?? null,
  }));
  const access = await accessMap(ctx, 'paper', rows, viewer);
  const mine = rows.filter((r) => r.space === 'personal' && r.ownerUserId === viewer.userId);
  const shared = await sharedIds(
    ctx,
    'paper',
    mine.map((r) => r.id),
  );
  return list.map((p) => ({
    ...p,
    access: access.get(p.id) ?? 'none',
    ...(p.space === 'personal' && p.ownerUserId === viewer.userId
      ? { shared: shared.has(p.id) }
      : {}),
  }));
}

/** 观看者能看到的全部论文 id（检索、问答只在这些里找） */
export async function visiblePaperIds(
  ctx: AppContext,
  projectId: string,
  viewer: Viewer,
): Promise<Set<string>> {
  const rows = await ctx.db.db
    .select({ id: papers.id })
    .from(papers)
    .where(and(eq(papers.projectId, projectId), visibleWhere('paper', papers, viewer)));
  return new Set(rows.map((r) => r.id));
}

export function bibOf(row: PaperRow): string {
  return toBibtex({
    citekey: row.citekey,
    title: row.title,
    authors: row.authors,
    year: row.year,
    venue: row.venue,
    doi: row.doi,
    arxivId: row.arxivId,
    url: row.url,
    meta: row.meta,
  });
}

export async function getPaperRow(
  ctx: AppContext,
  projectId: LibraryScopeInput,
  paperId: string,
): Promise<PaperRow> {
  const [row] = await ctx.db.db
    .select()
    .from(papers)
    .where(and(eq(papers.id, paperId), scopeWhere(papers, projectId)));
  if (!row) throw new ApiError('not_found', '论文不存在或已被删除');
  return row;
}

/** 按 id 或引用键找论文（agent 工具两种都会传） */
export async function findPaper(
  ctx: AppContext,
  projectId: LibraryScopeInput,
  ref: string,
  viewer: Viewer = TEAM_VIEWER,
): Promise<PaperRow | null> {
  // 引用键在团队库和每人的个人库里各自唯一：同名时 id 精确匹配优先，其次团队库、自己的
  const rows = await ctx.db.db
    .select()
    .from(papers)
    .where(
      and(
        scopeWhere(papers, projectId),
        libraryScope(projectId).kind === 'project'
          ? visibleWhere('paper', papers, viewer)
          : undefined,
        sql`(${papers.id} = ${ref} or ${papers.citekey} = ${ref})`,
      ),
    );
  return (
    rows.find((r) => r.id === ref) ??
    rows.find((r) => r.space === 'team') ??
    rows.find((r) => r.ownerUserId === viewer.userId) ??
    rows[0] ??
    null
  );
}

// ---------------------------------------------------------------- 写入与事件

type Patch = Partial<Omit<typeof papers.$inferInsert, 'id' | 'projectId' | 'createdAt'>>;

/** 版本守卫没通过（行还在，但 note_version 已变） */
class NoteVersionStale extends Error {}
class MetadataVersionStale extends Error {}

/**
 * 更新一行并发布 paper.updated（同一事务）。
 * 改 note 时 note_version 自动 +1；给了 noteBase 则只在 note_version 仍等于它时更新
 * （笔记乐观并发，比对与写入是同一条 UPDATE，并发的同版本修改只有一次成功）。
 */
export async function patchPaper(
  ctx: AppContext,
  row: Pick<PaperRow, 'id' | 'projectId' | 'ownerUserId'>,
  patch: Patch,
  actor: ActorRef = LIBRARY_ACTOR,
  noteBase?: number,
  metadataBase?: { title?: number; tags?: number },
): Promise<PaperRow> {
  const { next, ev } = await ctx.db.db.transaction(async (tx) => {
    const where =
      noteBase !== undefined
        ? and(eq(papers.id, row.id), eq(papers.noteVersion, noteBase))
        : eq(papers.id, row.id);
    const [next] = await tx
      .update(papers)
      .set({
        ...patch,
        ...(patch.note !== undefined ? { noteVersion: sql`${papers.noteVersion} + 1` } : {}),
        ...(patch.title !== undefined ? { titleVersion: sql`${papers.titleVersion} + 1` } : {}),
        ...(patch.tags !== undefined ? { tagsVersion: sql`${papers.tagsVersion} + 1` } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          where,
          scopeWhere(papers, scopeOf(row)),
          metadataBase?.title !== undefined
            ? eq(papers.titleVersion, metadataBase.title)
            : undefined,
          metadataBase?.tags !== undefined ? eq(papers.tagsVersion, metadataBase.tags) : undefined,
        ),
      )
      .returning();
    if (!next) {
      const [current] = await tx
        .select({ noteVersion: papers.noteVersion })
        .from(papers)
        .where(and(eq(papers.id, row.id), scopeWhere(papers, scopeOf(row))));
      if (!current) throw new ApiError('not_found', '论文不存在或已被删除');
      // 混合更新笔记和元数据时，保留旧笔记冲突契约，让原编辑器仍能合并草稿。
      if (noteBase !== undefined && noteBase !== current.noteVersion) throw new NoteVersionStale();
      throw new MetadataVersionStale();
    }
    const ev = next.projectId
      ? await ctx.bus.record(tx, {
          projectId: next.projectId,
          type: 'paper.updated',
          payload: toPaper(next),
          actor,
        })
      : null;
    return { next, ev };
  });
  if (ev) ctx.bus.emit(ev);
  return next;
}

async function takenCitekeys(
  ctx: AppContext,
  projectId: LibraryScopeInput,
  owner: string | null,
  exceptId?: string,
) {
  const rows = await ctx.db.db
    .select({ k: papers.citekey })
    .from(papers)
    .where(
      and(
        scopeWhere(papers, projectId),
        libraryScope(projectId).kind === 'project' ? sameLibrary(owner) : undefined,
        exceptId ? ne(papers.id, exceptId) : undefined,
      ),
    );
  return new Set(rows.map((r) => r.k));
}

/** 按当前元数据给论文定引用键（已经 fixed 的不动） */
export async function citekeyFor(
  ctx: AppContext,
  row: PaperRow,
  meta: { authors: PaperRow['authors']; year: number | null; title: string },
): Promise<string> {
  if (row.meta.citekeyFixed) return row.citekey;
  const base = baseCitekey(meta);
  return uniqueCitekey(base, await takenCitekeys(ctx, scopeOf(row), row.ownerUserId, row.id));
}

const placeholderKey = (id: string) => `paper${id.slice(-8).toLowerCase()}`;

// ---------------------------------------------------------------- 读

export async function listPapers(
  ctx: AppContext,
  projectId: LibraryScopeInput,
  q: PaperListQuery = {},
  viewer: Viewer = TEAM_VIEWER,
): Promise<Paper[]> {
  const archived = q.archived === 'true' || q.archived === '1';
  const conds: SQL[] = [
    scopeWhere(papers, projectId),
    libraryScope(projectId).kind === 'project'
      ? visibleWhere('paper', papers, viewer, q.space)
      : sql`true`,
    archived ? isNotNull(papers.archivedAt) : isNull(papers.archivedAt),
  ];
  if (q.status) conds.push(eq(papers.status, q.status));
  if (q.tag) conds.push(sql`${q.tag} = any(${papers.tags})`);
  if (q.q?.trim()) {
    const like = `%${q.q.trim().replace(/[%_\\]/gu, (c) => `\\${c}`)}%`;
    conds.push(
      sql`(${papers.title} ilike ${like} or ${papers.citekey} ilike ${like} or ${papers.authors}::text ilike ${like} or coalesce(${papers.doi}, '') ilike ${like} or coalesce(${papers.arxivId}, '') ilike ${like} or array_to_string(${papers.tags}, ' ') ilike ${like})`,
    );
  }
  const rows = await ctx.db.db
    .select()
    .from(papers)
    .where(and(...conds))
    .orderBy(desc(papers.createdAt));
  return rows.map(toPaper);
}

export async function getPaperDetail(
  ctx: AppContext,
  projectId: LibraryScopeInput,
  paperId: string,
): Promise<PaperDetail> {
  const row = await getPaperRow(ctx, projectId, paperId);
  const paper = toPaper(row);
  if (!row.structure) return { ...paper, structure: null };
  const chunks = await ctx.db.db
    .select()
    .from(paperChunks)
    .where(eq(paperChunks.paperId, paperId))
    .orderBy(asc(paperChunks.seq));
  return {
    ...paper,
    structure: {
      ...row.structure,
      chunks: chunks.map((c) => ({
        id: c.id,
        seq: c.seq,
        kind: c.kind,
        sectionIndex: c.sectionIndex,
        sectionPath: c.sectionPath,
        page: c.page,
        para: c.para,
        boxes: c.boxes,
        text: c.text,
      })),
    },
  };
}

// ---------------------------------------------------------------- 导入

export interface ImportRequest {
  doi?: string | undefined;
  arxiv?: string | undefined;
  url?: string | undefined;
  tags?: string[] | undefined;
}

export interface ImportOutcome {
  row: PaperRow;
  duplicate: boolean;
  /** 新建的需要排队解析 */
  enqueue: boolean;
}

async function findExisting(
  ctx: AppContext,
  projectId: LibraryScopeInput,
  owner: string | null,
  by: { doi?: string | null; arxivId?: string | null; sha?: string | null; url?: string | null },
): Promise<PaperRow | null> {
  const ors: SQL[] = [];
  if (by.doi) ors.push(eq(papers.doi, by.doi));
  if (by.arxivId) ors.push(eq(papers.arxivId, by.arxivId));
  if (by.sha) ors.push(eq(papers.pdfSha256, by.sha));
  if (by.url) ors.push(eq(papers.pdfUrl, by.url));
  if (ors.length === 0) return null;
  const [row] = await ctx.db.db
    .select()
    .from(papers)
    .where(
      and(
        scopeWhere(papers, projectId),
        libraryScope(projectId).kind === 'project' ? sameLibrary(owner) : undefined,
        sql`(${sql.join(ors, sql` or `)})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 已存在：归档的恢复出来，返回已有那篇 */
async function reviveDuplicate(ctx: AppContext, actor: ActorRef, row: PaperRow) {
  if (!row.archivedAt) return row;
  invalidateIndex(ctx, scopeOf(row));
  return patchPaper(ctx, row, { archivedAt: null }, actor);
}

async function insertPaper(
  ctx: AppContext,
  actor: ActorRef,
  projectId: LibraryScopeInput,
  owner: string | null,
  values: {
    privatePdfPath?: string | null;
    source: PaperSource;
    title: string;
    doi?: string | null;
    arxivId?: string | null;
    url?: string | null;
    pdfUrl?: string | null;
    pdfSha256?: string | null;
    fileId?: string | null;
    tags?: string[];
  },
): Promise<PaperRow> {
  const id = `${LIBRARY_ID_PREFIX.paper}_${ulid()}`;
  const { row, ev } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(papers)
      .values({
        id,
        ...scopeValues(projectId),
        title: values.title,
        doi: values.doi ?? null,
        arxivId: values.arxivId ?? null,
        url: values.url ?? null,
        pdfUrl: values.pdfUrl ?? null,
        pdfSha256: values.pdfSha256 ?? null,
        fileId: values.fileId ?? null,
        privatePdfPath: values.privatePdfPath ?? null,
        space: libraryScope(projectId).kind === 'personal' || owner ? 'personal' : 'team',
        ownerUserId: owner ?? scopeValues(projectId).ownerUserId,
        citekey: placeholderKey(id),
        tags: values.tags ?? [],
        source: values.source,
        status: 'queued',
        progress: 0,
        stage: '排队等待解析',
        createdBy: actor,
      })
      .returning();
    const ev = row!.projectId
      ? await ctx.bus.record(tx, {
          projectId: row!.projectId,
          type: 'paper.created',
          payload: toPaper(row!),
          actor,
        })
      : null;
    return { row: row!, ev };
  });
  if (ev) ctx.bus.emit(ev);
  return row;
}

const isUniqueViolation = (err: unknown) =>
  /duplicate key|unique constraint/iu.test(String((err as Error)?.message ?? '')) ||
  (err as { code?: string })?.code === '23505' ||
  (err as { cause?: { code?: string } })?.cause?.code === '23505';

/** DOI / arXiv / PDF 链接导入（元数据与 PDF 由流水线拉取） */
export async function importByRef(
  ctx: AppContext,
  actor: ActorRef,
  projectId: LibraryScopeInput,
  input: ImportRequest,
  /** 导入到谁的个人文献；null = 团队文献库 */
  owner: string | null = null,
): Promise<ImportOutcome> {
  let arxivId: string | null = null;
  let doi: string | null = null;
  let url: string | null = null;
  if (input.arxiv) {
    arxivId = normalizeArxivId(input.arxiv);
    if (!arxivId) throw new ApiError('validation_failed', `不是有效的 arXiv 编号：${input.arxiv}`);
  } else if (input.doi) {
    doi = normalizeDoi(input.doi);
    if (!doi) throw new ApiError('validation_failed', `不是有效的 DOI：${input.doi}`);
    arxivId = arxivIdFromDoi(doi);
    if (arxivId) doi = null;
  } else if (input.url) {
    const asArxiv = /arxiv\.org\/(?:abs|pdf)\//iu.test(input.url)
      ? normalizeArxivId(input.url)
      : null;
    const asDoi = /doi\.org\//iu.test(input.url) ? normalizeDoi(input.url) : null;
    if (asArxiv) arxivId = asArxiv;
    else if (asDoi) doi = asDoi;
    else url = input.url.trim();
  } else {
    throw new ApiError('validation_failed', '请填写 DOI、arXiv 编号或 PDF 链接');
  }

  const existing = await findExisting(ctx, projectId, owner, { doi, arxivId, url });
  if (existing) {
    return { row: await reviveDuplicate(ctx, actor, existing), duplicate: true, enqueue: false };
  }
  const source: PaperSource = arxivId ? 'arxiv' : doi ? 'doi' : 'url';
  const title = arxivId ? `arXiv:${arxivId}` : doi ? `DOI ${doi}` : (url ?? '');
  try {
    const row = await insertPaper(ctx, actor, projectId, owner, {
      source,
      title,
      doi,
      arxivId,
      url: arxivId ? `https://arxiv.org/abs/${arxivId}` : doi ? `https://doi.org/${doi}` : url,
      pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : url,
      tags: input.tags ?? [],
    });
    return { row, duplicate: false, enqueue: true };
  } catch (err) {
    // 并发导入同一篇：唯一索引兜底
    if (isUniqueViolation(err)) {
      const again = await findExisting(ctx, projectId, owner, { doi, arxivId, url });
      if (again) return { row: again, duplicate: true, enqueue: false };
    }
    throw err;
  }
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function pdfFileName(name: string): string {
  const base = (name.replace(/\\/gu, '/').split('/').pop() ?? 'paper.pdf')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, '_')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '');
  const stem = base.replace(/\.pdf$/iu, '').slice(0, 80) || 'paper';
  return `${stem}.pdf`;
}

/** 把 PDF 存进项目共享文件夹（library/ 目录） */
export async function storePdf(
  ctx: AppContext,
  actor: ActorRef,
  projectId: LibraryScopeInput,
  name: string,
  data: Buffer,
): Promise<string> {
  return writeLibraryPdf(ctx, actor, projectId, pdfFileName(name), data);
}

// ---------------------------------------------------------------- 个人文献的 PDF

/**
 * 个人文献的 PDF 不进项目共享文件夹（那里所有成员都能看到、会发 file.created），
 * 存在 STORAGE_DIR/_private/<projectId>/ 下，库里只记相对路径；读 PDF 的端点按论文权限检查。
 */
const PRIVATE_DIR = '_private';

export function privateAbs(ctx: AppContext, rel: string): string {
  const base = resolve(ctx.config.STORAGE_DIR, PRIVATE_DIR);
  const abs = resolve(base, rel);
  if (!abs.startsWith(base + sep)) throw new ApiError('bad_request', '文件路径不合法');
  return abs;
}

/** 按论文所在空间存 PDF：团队 → 共享文件夹 library/；个人 → 私有目录 */
export async function storePaperPdf(
  ctx: AppContext,
  actor: ActorRef,
  row: { projectId: string | null; ownerUserId: string | null; id?: string },
  name: string,
  data: Buffer,
): Promise<{ fileId: string | null; privatePdfPath: string | null }> {
  if (!row.projectId) {
    return { fileId: await storePdf(ctx, actor, scopeOf(row), name, data), privatePdfPath: null };
  }
  if (!row.ownerUserId) {
    return { fileId: await storePdf(ctx, actor, row.projectId, name, data), privatePdfPath: null };
  }
  const rel = `${row.projectId}/${sha256(data).slice(0, 24)}.pdf`;
  const abs = privateAbs(ctx, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return { fileId: null, privatePdfPath: rel };
}

/** 论文的 PDF 字节（团队库读共享文件夹，个人文献读私有目录）；没有返回 null */
export async function readPaperPdf(ctx: AppContext, row: PaperRow): Promise<Buffer | null> {
  try {
    if (row.privatePdfPath) return await readFile(privateAbs(ctx, row.privatePdfPath));
    if (!row.fileId) return null;
    const file = await getLibraryFile(ctx, scopeOf(row), row.fileId);
    return file ? await readFile(libraryDiskPath(ctx, scopeOf(row), file.path)) : null;
  } catch {
    return null;
  }
}

/**
 * 个人文献 ↔ 团队文献库。
 * - 加入团队库：只有所有者；同一篇已在团队库（DOI / arXiv / PDF 相同）时拒绝，提示直接用团队库那篇；
 *   PDF 复制进共享文件夹，分享设置作废；引用键和团队库冲突时自动改名。
 * - 移回个人：创建者或负责人 / 导师；PDF 留在共享文件夹不动（其他成员已能看到的文件不收回）。
 */
export async function movePaperSpace(
  ctx: AppContext,
  actor: ActorRef & { kind: 'user'; id: string },
  role: ProjectRole,
  projectId: string,
  paperId: string,
  space: ResourceSpace,
): Promise<Paper> {
  const row = await getPaperRow(ctx, projectId, paperId);
  if (role === 'guest') throw new ApiError('forbidden', '访客不能移动文献');
  if (row.space === space) return toPaper(row);
  const owner = space === 'personal' ? actor.id : null;
  if (space === 'team') {
    if (row.ownerUserId !== actor.id) {
      throw new ApiError('forbidden', '只有所有者能把它加入团队文献库');
    }
  } else {
    const creator = row.createdBy.kind === 'user' && row.createdBy.id === actor.id;
    if (!creator && role !== 'owner' && role !== 'advisor') {
      throw new ApiError('forbidden', '只有导入者或负责人、导师能把团队文献移到个人空间');
    }
  }
  const dup = await findExisting(ctx, projectId, owner, {
    doi: row.doi,
    arxivId: row.arxivId,
    sha: row.pdfSha256,
  });
  if (dup && dup.id !== row.id) {
    throw new ApiError(
      'conflict',
      space === 'team'
        ? `团队文献库里已经有这篇（《${dup.title}》），直接用团队库那篇即可`
        : `你的个人文献里已经有这篇（《${dup.title}》）`,
    );
  }
  const patch: Patch = { space, ownerUserId: owner };
  // PDF：个人 → 团队时复制进共享文件夹
  if (space === 'team' && row.privatePdfPath) {
    const pdf = await readPaperPdf(ctx, row);
    if (pdf) {
      patch.fileId = await storePdf(ctx, actor, projectId, `${row.citekey}.pdf`, pdf);
      patch.privatePdfPath = null;
    }
  }
  const taken = await takenCitekeys(ctx, projectId, owner, row.id);
  if (taken.has(row.citekey)) patch.citekey = uniqueCitekey(row.citekey, taken);
  // 先改受众再发事件：移入个人空间后其他人立即收不到这篇的事件
  if (owner) setPersonalAudience(row.id, owner);
  else clearPersonalAudience(row.id);
  const next = await patchPaper(ctx, row, patch, actor);
  if (space === 'team' && row.privatePdfPath && !next.privatePdfPath) {
    await rm(privateAbs(ctx, row.privatePdfPath), { force: true }).catch(() => undefined);
  }
  await clearSharing(ctx, 'paper', [row.id]);
  invalidateIndex(ctx, projectId);
  await notifySpaceChanged(
    ctx,
    { kind: 'paper', id: row.id, projectId, space, ownerUserId: owner },
    actor,
  );
  return toPaper(next);
}

/** 上传 PDF 导入：同一个文件（sha256）只导入一次 */
export async function importUpload(
  ctx: AppContext,
  actor: ActorRef,
  projectId: LibraryScopeInput,
  upload: { data: Buffer; filename: string; tags?: string[] | undefined },
  owner: string | null = null,
): Promise<ImportOutcome> {
  if (upload.data.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new ApiError('validation_failed', '上传的不是 PDF 文件');
  }
  const sha = sha256(upload.data);
  const existing = await findExisting(ctx, projectId, owner, { sha });
  if (existing) {
    return { row: await reviveDuplicate(ctx, actor, existing), duplicate: true, enqueue: false };
  }
  const stored = await storePaperPdf(
    ctx,
    actor,
    { ...scopeValues(projectId), ownerUserId: owner ?? scopeValues(projectId).ownerUserId },
    upload.filename,
    upload.data,
  );
  const row = await insertPaper(ctx, actor, projectId, owner, {
    source: 'upload',
    title: pdfFileName(upload.filename).replace(/\.pdf$/iu, ''),
    pdfSha256: sha,
    ...stored,
    tags: upload.tags ?? [],
  });
  return { row, duplicate: false, enqueue: true };
}

/** 给已有论文补传 / 替换 PDF（“没有开放获取 PDF”的论文） */
export async function attachPdf(
  ctx: AppContext,
  actor: ActorRef,
  projectId: LibraryScopeInput,
  paperId: string,
  upload: { data: Buffer; filename: string },
): Promise<PaperRow> {
  const row = await getPaperRow(ctx, projectId, paperId);
  if (upload.data.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new ApiError('validation_failed', '上传的不是 PDF 文件');
  }
  const sha = sha256(upload.data);
  const other = await findExisting(ctx, projectId, row.ownerUserId, { sha });
  if (other && other.id !== row.id) {
    throw new ApiError('conflict', `这个 PDF 已经属于《${other.title}》`);
  }
  const name = row.citekey.startsWith('paper') ? upload.filename : `${row.citekey}.pdf`;
  const stored = await storePaperPdf(ctx, actor, row, name, upload.data);
  return patchPaper(
    ctx,
    row,
    {
      ...stored,
      pdfSha256: sha,
      status: 'queued',
      progress: 0,
      stage: '排队等待解析',
      error: null,
      attempts: 0,
    },
    actor,
  );
}

// ---------------------------------------------------------------- 改、删

export async function updatePaper(
  ctx: AppContext,
  actor: ActorRef,
  projectId: LibraryScopeInput,
  paperId: string,
  input: PaperUpdateWithVersionsInput,
): Promise<Paper> {
  const row = await getPaperRow(ctx, projectId, paperId);
  const patch: Patch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.tags !== undefined) patch.tags = [...new Set(input.tags)];
  if (input.note !== undefined) patch.note = input.note;
  if (input.archived !== undefined) patch.archivedAt = input.archived ? new Date() : null;
  // baseNoteVersion 只约束笔记：不改 note 时忽略
  const noteBase = input.note !== undefined ? input.baseNoteVersion : undefined;
  let next: PaperRow;
  try {
    next = await patchPaper(ctx, row, patch, actor, noteBase, {
      title: input.title !== undefined ? (input.baseTitleVersion ?? row.titleVersion) : undefined,
      tags: input.tags !== undefined ? (input.baseTagsVersion ?? row.tagsVersion) : undefined,
    });
  } catch (err) {
    if (err instanceof MetadataVersionStale) {
      const current = await getPaperRow(ctx, projectId, paperId);
      throw new ApiError(
        'version_conflict',
        '你修改的字段已被其他成员更新，请核对最新内容后再保存',
        {
          current: toPaper(current),
        },
      );
    }
    if (!(err instanceof NoteVersionStale)) throw err;
    // 别人先改了笔记：整个 PATCH 不生效，把最新笔记和版本给前端合并
    const current = await getPaperRow(ctx, projectId, paperId);
    throw new ApiError('version_conflict', '笔记已被他人修改，已为你载入最新版本，请合并后再保存', {
      current: toPaper(current),
      note: current.note,
      noteVersion: current.noteVersion,
    });
  }
  if (input.archived !== undefined || input.title !== undefined) invalidateIndex(ctx, projectId);
  return toPaper(next);
}

export async function deletePaper(
  ctx: AppContext,
  actor: ActorRef,
  projectId: LibraryScopeInput,
  paperId: string,
): Promise<void> {
  const row = await getPaperRow(ctx, projectId, paperId);
  const { ev, notes, annotations, qaTurns } = await ctx.db.db.transaction(async (tx) => {
    // 与标注写入同序锁定项目、论文；收集连接期间不能插入漏关的新标注。
    if (row.projectId)
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, row.projectId))
        .for('update');
    const [locked] = await tx
      .select({ id: papers.id })
      .from(papers)
      .where(eq(papers.id, row.id))
      .for('update');
    if (!locked) throw new ApiError('not_found', '论文已删除');
    const notes = await tx
      .select({ id: paperNotes.id })
      .from(paperNotes)
      .where(eq(paperNotes.paperId, paperId));
    const annotations = await tx
      .select({ id: paperAnnotations.id })
      .from(paperAnnotations)
      .where(eq(paperAnnotations.paperId, paperId));
    const qaTurns = await tx
      .select({ id: paperQaTurns.id })
      .from(paperQaTurns)
      .where(eq(paperQaTurns.paperId, paperId));
    await tx.delete(papers).where(eq(papers.id, row.id));
    const ev = row.projectId
      ? await ctx.bus.record(tx, {
          projectId: row.projectId,
          type: 'paper.deleted',
          payload: { id: row.id },
          actor,
        })
      : null;
    return { ev, notes, annotations, qaTurns };
  });
  if (ev) ctx.bus.emit(ev);
  for (const note of notes) closeDocumentConnections(ctx, note.id);
  for (const annotation of annotations) closeDocumentConnections(ctx, annotation.id);
  for (const turn of qaTurns) closeDocumentConnections(ctx, turn.id);
  abortQaTurns(
    ctx,
    qaTurns.map((t) => t.id),
  );
  invalidateIndex(ctx, projectId);
  await clearSharing(ctx, 'paper', [row.id]);
  if (row.privatePdfPath) await rm(privateAbs(ctx, row.privatePdfPath), { force: true });
  // 文献库自己存的 PDF 一起删掉（别处上传到其他目录的不动）
  if (row.fileId) {
    const file = await getLibraryFile(ctx, projectId, row.fileId);
    if (file?.path.startsWith(`${LIBRARY_DIR}/`)) {
      await deleteLibraryFile(ctx, actor, projectId, file.id).catch(() => undefined);
    }
  }
}

/** 需要重新解析：清掉进度，交给队列 */
export async function resetForReparse(
  ctx: AppContext,
  actor: ActorRef,
  projectId: LibraryScopeInput,
  paperId: string,
): Promise<PaperRow> {
  const row = await getPaperRow(ctx, projectId, paperId);
  if (['fetching', 'parsing', 'indexing'].includes(row.status)) {
    throw new ApiError('conflict', '这篇论文正在解析，等它完成后再试');
  }
  return patchPaper(
    ctx,
    row,
    { status: 'queued', progress: 0, stage: '排队等待解析', error: null, attempts: 0 },
    actor,
  );
}

export async function listByIds(
  ctx: AppContext,
  projectId: LibraryScopeInput,
  ids: string[] | undefined,
  viewer: Viewer = TEAM_VIEWER,
): Promise<PaperRow[]> {
  // 不指定 id = 团队文献库全部；指定 id 时可以含自己能看到的个人文献
  const scope = ids && ids.length ? 'all' : 'team';
  const rows = await ctx.db.db
    .select()
    .from(papers)
    .where(
      and(
        scopeWhere(papers, projectId),
        isNull(papers.archivedAt),
        libraryScope(projectId).kind === 'project'
          ? visibleWhere('paper', papers, viewer, scope)
          : undefined,
      ),
    )
    .orderBy(asc(papers.citekey));
  if (!ids || ids.length === 0) return rows;
  const want = new Set(ids);
  const byId = rows.filter((r) => want.has(r.id) || want.has(r.citekey));
  if (byId.length === 0) throw new ApiError('not_found', '没有找到这些论文');
  return byId;
}

export type { PaperBibMeta };
