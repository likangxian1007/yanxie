import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { ApiError, isId, newId, type ActorRef, PAPER_PDF_MAX_BYTES } from '@srh/shared';
import type { AppContext } from '../../context';
import { files } from '../../db/schema';
import {
  deleteProjectFile,
  diskPath,
  getFile,
  normalizePath,
  uniquePath,
  writeProjectFile,
} from '../files/service';
import { libraryScope, scopeValues, scopeWhere, type LibraryScopeInput } from './scope';

/** 私人 PDF 与项目目录隔开；下载前仍须校验登录身份和记录归属。 */
export function libraryDiskPath(ctx: AppContext, value: LibraryScopeInput, path: string): string {
  const scope = libraryScope(value);
  if (scope.kind === 'project') return diskPath(ctx, scope.projectId, path);
  if (!isId('user', scope.ownerUserId)) throw new ApiError('bad_request', '个人库归属无效');
  return diskPath(ctx, `personal/${scope.ownerUserId}`, path);
}

export async function getLibraryFile(ctx: AppContext, value: LibraryScopeInput, fileId: string) {
  const scope = libraryScope(value);
  if (scope.kind === 'project') return getFile(ctx, scope.projectId, fileId);
  const [row] = await ctx.db.db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), scopeWhere(files, scope)));
  return row ?? null;
}

/** 私人 PDF 使用唯一物理路径，没有项目广播，也不会生成项目文件版本。 */
export async function writeLibraryPdf(
  ctx: AppContext,
  actor: ActorRef,
  value: LibraryScopeInput,
  name: string,
  data: Buffer,
): Promise<string> {
  const scope = libraryScope(value);
  if (scope.kind === 'project') {
    const path = await uniquePath(ctx, scope.projectId, `library/${name}`);
    return (
      await writeProjectFile(
        ctx,
        actor,
        scope.projectId,
        path,
        data,
        'application/pdf',
        PAPER_PDF_MAX_BYTES,
      )
    ).file.id;
  }
  if (data.length > PAPER_PDF_MAX_BYTES) throw new ApiError('bad_request', 'PDF 不能超过 100 MB');
  const id = newId('file');
  const path = normalizePath(`library/${id}/${name}`);
  const abs = libraryDiskPath(ctx, scope, path);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  try {
    await writeFile(tmp, data, { flag: 'wx' });
    await rename(tmp, abs);
    await ctx.db.db.insert(files).values({
      id,
      ...scopeValues(scope),
      name,
      path,
      mime: 'application/pdf',
      size: data.length,
      uploadedBy: actor,
    });
  } catch (err) {
    await rm(tmp, { force: true });
    await rm(abs, { force: true });
    throw err;
  }
  return id;
}

export async function deleteLibraryFile(
  ctx: AppContext,
  actor: ActorRef,
  value: LibraryScopeInput,
  fileId: string,
): Promise<void> {
  const scope = libraryScope(value);
  if (scope.kind === 'project') return deleteProjectFile(ctx, actor, scope.projectId, fileId);
  const [row] = await ctx.db.db
    .delete(files)
    .where(and(eq(files.id, fileId), scopeWhere(files, scope)))
    .returning();
  if (row) await rm(libraryDiskPath(ctx, scope, row.path), { force: true });
}
