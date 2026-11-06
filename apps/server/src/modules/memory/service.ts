import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ApiError,
  newId,
  type ActorRef,
  type MemoryFile,
  type MemoryWriteInput,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { memoryFiles } from '../../db/schema';

export type MemoryRow = typeof memoryFiles.$inferSelect;
export type MemoryWrite = z.infer<typeof MemoryWriteInput>;
export type MemoryMeta = Omit<MemoryFile, 'content'>;

/** 记忆索引文件：每次唤醒全文注入，不能删除 */
export const MEMORY_INDEX_PATH = 'MEMORY.md';

const PATH_RE = /^[\w\-./]+\.md$/u;

/** 记忆路径：与 MemoryWriteInput 相同的字符集，不能以 / 开头，不能有 . / .. / 空段 */
export function isValidMemoryPath(path: string): boolean {
  if (!PATH_RE.test(path) || path.startsWith('/') || path.length > 300) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function assertPath(path: string): void {
  if (!isValidMemoryPath(path)) {
    throw new ApiError(
      'bad_request',
      '记忆文件路径不合法：只能用字母数字、- _ . /，以 .md 结尾，不能含 ..',
    );
  }
}

export function toMemoryFile(row: MemoryRow): MemoryFile {
  return {
    id: row.id,
    projectId: row.projectId,
    path: row.path,
    description: row.description,
    type: row.type ?? null,
    content: row.content,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMeta(row: MemoryRow): MemoryMeta {
  const { content: _content, ...meta } = toMemoryFile(row);
  return meta;
}

/** 记忆文件清单（不含正文）：MEMORY.md 在最前，其余按路径排序 */
export async function listMemory(ctx: AppContext, projectId: string): Promise<MemoryMeta[]> {
  const rows = await ctx.db.db
    .select()
    .from(memoryFiles)
    .where(eq(memoryFiles.projectId, projectId));
  return rows
    .sort((a, b) => {
      if (a.path === MEMORY_INDEX_PATH) return -1;
      if (b.path === MEMORY_INDEX_PATH) return 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    })
    .map(toMeta);
}

async function getRow(ctx: AppContext, projectId: string, path: string) {
  const [row] = await ctx.db.db
    .select()
    .from(memoryFiles)
    .where(and(eq(memoryFiles.projectId, projectId), eq(memoryFiles.path, path)));
  return row ?? null;
}

export async function readMemory(
  ctx: AppContext,
  projectId: string,
  path: string,
): Promise<MemoryFile | null> {
  if (!isValidMemoryPath(path)) return null;
  const row = await getRow(ctx, projectId, path);
  return row ? toMemoryFile(row) : null;
}

/**
 * 写记忆（乐观并发）：baseVersion=0 新建（已存在 → 409 version_conflict）；
 * baseVersion=n 仅当当前版本恰为 n 时更新（原子 UPDATE … WHERE version = n），否则 409 并附最新对象。
 */
export async function writeMemory(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: MemoryWrite,
): Promise<MemoryFile> {
  assertPath(input.path);
  const conflict = (current: MemoryRow) =>
    new ApiError('version_conflict', '记忆文件已被修改，请基于最新版本重新编辑', {
      current: toMemoryFile(current),
    });

  const { file, ev } = await ctx.db.db.transaction(async (tx) => {
    let row: MemoryRow | undefined;
    if (input.baseVersion === 0) {
      [row] = await tx
        .insert(memoryFiles)
        .values({
          id: newId('memory'),
          projectId,
          path: input.path,
          description: input.description,
          type: input.type,
          content: input.content,
          version: 1,
          updatedBy: actor,
        })
        .onConflictDoNothing()
        .returning();
    } else {
      [row] = await tx
        .update(memoryFiles)
        .set({
          description: input.description,
          type: input.type,
          content: input.content,
          version: input.baseVersion + 1,
          updatedBy: actor,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(memoryFiles.projectId, projectId),
            eq(memoryFiles.path, input.path),
            eq(memoryFiles.version, input.baseVersion),
          ),
        )
        .returning();
    }
    if (!row) {
      const [current] = await tx
        .select()
        .from(memoryFiles)
        .where(and(eq(memoryFiles.projectId, projectId), eq(memoryFiles.path, input.path)));
      if (!current) throw new ApiError('not_found', '记忆文件不存在（新建请传 baseVersion=0）');
      throw conflict(current);
    }
    const file = toMemoryFile(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'memory.updated',
      payload: file,
      actor,
    });
    return { file, ev };
  });
  ctx.bus.emit(ev);
  return file;
}

/** 删除记忆文件（MEMORY.md 不能删）；baseVersion 过期 → 409 version_conflict */
export async function deleteMemory(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  path: string,
  baseVersion: number,
): Promise<void> {
  assertPath(path);
  if (path === MEMORY_INDEX_PATH) {
    throw new ApiError('conflict', 'MEMORY.md 是记忆索引，不能删除');
  }
  const ev = await ctx.db.db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(memoryFiles)
      .where(
        and(
          eq(memoryFiles.projectId, projectId),
          eq(memoryFiles.path, path),
          eq(memoryFiles.version, baseVersion),
        ),
      )
      .returning({ id: memoryFiles.id });
    if (!deleted) {
      const [current] = await tx
        .select()
        .from(memoryFiles)
        .where(and(eq(memoryFiles.projectId, projectId), eq(memoryFiles.path, path)));
      if (!current) throw new ApiError('not_found', '记忆文件不存在');
      throw new ApiError('version_conflict', '记忆文件已被修改，请刷新后再删除', {
        current: toMemoryFile(current),
      });
    }
    return ctx.bus.record(tx, {
      projectId,
      type: 'memory.deleted',
      payload: { path },
      actor,
    });
  });
  ctx.bus.emit(ev);
}
