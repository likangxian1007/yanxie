import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { ApiError, isId, newId, type ActorRef, type FileObject } from '@srh/shared';
import type { AppContext } from '../../context';
import { files } from '../../db/schema';

/**
 * 项目共享文件夹。文件本体在 <STORAGE_DIR>/<projectId>/<path>，元数据在 files 表（项目内路径唯一）。
 * agent 的 read_file / write_file 与 REST 上传下载共用这里的函数。
 */
export type FileRow = typeof files.$inferSelect;

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PATH_LEN = 300;

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  py: 'text/x-python',
  ipynb: 'application/x-ipynb+json',
  tex: 'text/x-tex',
  bib: 'text/x-bibtex',
  html: 'text/html',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

/** 按扩展名猜 MIME；未知为 application/octet-stream */
export function guessMime(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/u.exec(path);
  return (m && MIME_BY_EXT[m[1]!.toLowerCase()]) || 'application/octet-stream';
}

/** 能当文本读给 agent 的 MIME */
export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    /^application\/(json|x-ndjson|yaml|xml|x-ipynb\+json|javascript|x-tex)\b/u.test(mime)
  );
}

/** Windows 保留设备名（不分大小写，带不带扩展名都算），如 CON、nul.txt、COM1.log */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

export function isReservedName(seg: string): boolean {
  return RESERVED_NAME.test(seg);
}

/**
 * 规范化项目内路径：反斜杠 → /，去掉开头的 / 与 ./，去掉 . 段；
 * 拒绝 ..、空路径、空段、控制字符、盘符（C:）、超过 300 字符；
 * 为了在 Windows / 大小写不敏感的文件系统上也安全，再拒绝 <>:"|?*、
 * 以点或空格结尾的段（Windows 会悄悄去掉）、保留设备名（CON、NUL、COM1…）。
 */
export function normalizePath(p: string): string {
  const bad = (why: string): never => {
    throw new ApiError('bad_request', `文件路径不合法：${why}`);
  };
  if (typeof p !== 'string') bad('不是字符串');
  if (p.includes('\0')) bad('含有非法字符');
  let s = p.trim().replace(/\\/gu, '/');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(s)) bad('含有控制字符');
  if (/^[A-Za-z]:/u.test(s)) bad('不能是绝对路径');
  for (;;) {
    if (s.startsWith('./')) s = s.slice(2);
    else if (s.startsWith('/')) s = s.slice(1);
    else break;
  }
  const segs = s.split('/').filter((seg) => seg !== '.');
  if (segs.some((seg) => seg === '..')) bad('不能包含 ..');
  if (segs.length === 0 || segs.some((seg) => seg === '')) bad('不能为空或包含空目录名');
  for (const seg of segs) {
    if (/[<>:"|?*]/u.test(seg)) bad('不能包含 < > : " | ? * 这些字符');
    if (/[. ]$/u.test(seg)) bad('文件名或目录名不能以点或空格结尾');
    if (isReservedName(seg)) bad(`“${seg}”是系统保留名，请换个名字`);
  }
  const out = segs.join('/');
  if (out.length > MAX_PATH_LEN) bad(`不能超过 ${MAX_PATH_LEN} 个字符`);
  return out;
}

function storageRoot(ctx: AppContext): string {
  return resolve(ctx.config.STORAGE_DIR);
}

/** 文件在磁盘上的绝对路径（再次确认没有逃出项目目录） */
export function diskPath(ctx: AppContext, projectId: string, path: string): string {
  const base = resolve(storageRoot(ctx), projectId);
  const abs = resolve(base, normalizePath(path));
  if (!abs.startsWith(base + sep)) throw new ApiError('bad_request', '文件路径不合法');
  return abs;
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function toFile(row: FileRow): FileObject {
  // 此 DTO 只用于项目文件；私人 PDF 不能进入项目事件或通用文件接口。
  if (!row.projectId || row.ownerUserId) throw new ApiError('not_found', '项目文件不存在');
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    path: row.path,
    mime: row.mime,
    size: row.size,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 列文件；给 dir 时只列该目录（含子目录）下的文件；按路径排序 */
export async function listFiles(
  ctx: AppContext,
  projectId: string,
  dir?: string,
): Promise<FileObject[]> {
  const rows = await ctx.db.db
    .select()
    .from(files)
    .where(eq(files.projectId, projectId))
    .orderBy(asc(files.path));
  const trimmed = dir?.trim().replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (!trimmed) return rows.map(toFile);
  const prefix = `${normalizePath(trimmed)}/`;
  return rows.filter((r) => r.path.startsWith(prefix)).map(toFile);
}

export async function getFile(
  ctx: AppContext,
  projectId: string,
  fileId: string,
): Promise<FileRow | null> {
  const [row] = await ctx.db.db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.projectId, projectId)));
  return row ?? null;
}

/**
 * 按路径找文件，不区分大小写（Windows / macOS 的磁盘上 A.txt 与 a.txt 是同一个文件）。
 * 万一库里已有只差大小写的多条旧记录，优先完全一致的，其次最早的。
 */
export async function getFileByPath(
  ctx: AppContext,
  projectId: string,
  path: string,
): Promise<FileRow | null> {
  const norm = normalizePath(path);
  const rows = await ctx.db.db
    .select()
    .from(files)
    .where(and(eq(files.projectId, projectId), sql`lower(${files.path}) = lower(${norm})`))
    .orderBy(asc(files.createdAt));
  return rows.find((r) => r.path === norm) ?? rows[0] ?? null;
}

/** 给定路径已存在时，生成 `name (1).ext`、`name (2).ext`… 中第一个空闲的路径 */
export async function uniquePath(
  ctx: AppContext,
  projectId: string,
  path: string,
): Promise<string> {
  const norm = normalizePath(path);
  if (!(await getFileByPath(ctx, projectId, norm))) return norm;
  const slash = norm.lastIndexOf('/');
  const dirPart = slash < 0 ? '' : norm.slice(0, slash + 1);
  const name = norm.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = `${dirPart}${stem} (${i})${ext}`;
    if (!(await getFileByPath(ctx, projectId, candidate))) return candidate;
  }
  throw new ApiError('conflict', '同名文件太多，请换个文件名');
}

/**
 * 写文件（新建或覆盖）：先落盘（临时文件 + rename），再 upsert 元数据，
 * 发布 file.created（新路径）或 file.updated（覆盖已有路径）。
 */
export async function writeProjectFile(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  path: string,
  data: Buffer | string,
  mime?: string,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<{ file: FileObject; created: boolean }> {
  // 与已有文件只差大小写时视为同一个文件：沿用已有的路径原地覆盖
  const norm = (await getFileByPath(ctx, projectId, path))?.path ?? normalizePath(path);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (bytes.length > maxBytes) {
    throw new ApiError('bad_request', `文件不能超过 ${Math.round(maxBytes / 1048576)} MB`);
  }
  const abs = diskPath(ctx, projectId, norm);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.${newId('file').slice(-8)}.tmp`;
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }

  const id = newId('file');
  const values = {
    name: baseName(norm),
    mime: mime || guessMime(norm),
    size: bytes.length,
    uploadedBy: actor,
  };
  const { file, created, ev } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(files)
      .values({ id, projectId, path: norm, ...values })
      .onConflictDoUpdate({ target: [files.projectId, files.path], set: values })
      .returning();
    const file = toFile(row!);
    const created = file.id === id;
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: created ? 'file.created' : 'file.updated',
      payload: file,
      actor,
    });
    return { file, created, ev };
  });
  ctx.bus.emit(ev);
  return { file, created };
}

/** 按 id 或路径读文本（最多 maxBytes 字节）；二进制文件返回空文本 */
export async function readProjectFileText(
  ctx: AppContext,
  projectId: string,
  pathOrId: string,
  maxBytes = 200_000,
): Promise<{ file: FileObject; text: string; truncated: boolean }> {
  const row = isId('file', pathOrId)
    ? await getFile(ctx, projectId, pathOrId)
    : await getFileByPath(ctx, projectId, pathOrId);
  if (!row) throw new ApiError('not_found', '文件不存在');
  const file = toFile(row);
  if (!isTextMime(row.mime)) return { file, text: '', truncated: false };
  let handle;
  try {
    handle = await open(diskPath(ctx, projectId, row.path), 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ApiError('not_found', '文件内容已丢失');
    }
    throw err;
  }
  try {
    const want = Math.max(0, Math.min(maxBytes, MAX_FILE_BYTES));
    const buf = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buf, 0, want, 0);
    const stat = await handle.stat();
    const truncated = stat.size > bytesRead;
    let text = new TextDecoder('utf-8').decode(buf.subarray(0, bytesRead));
    if (truncated) text = text.replace(/\uFFFD+$/u, ''); // 截断处可能切开多字节字符
    return { file, text, truncated };
  } finally {
    await handle.close();
  }
}

/** 删除文件：删元数据并发布 file.deleted，再删磁盘文件（不存在则忽略） */
export async function deleteProjectFile(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  fileId: string,
): Promise<void> {
  const { row, ev } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .delete(files)
      .where(and(eq(files.id, fileId), eq(files.projectId, projectId)))
      .returning();
    if (!row) throw new ApiError('not_found', '文件不存在');
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'file.deleted',
      payload: { id: fileId },
      actor,
    });
    return { row, ev };
  });
  ctx.bus.emit(ev);
  try {
    await rm(diskPath(ctx, projectId, row.path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[files] 删除磁盘文件失败', err);
    }
  }
}
