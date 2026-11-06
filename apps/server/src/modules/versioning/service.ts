import { and, desc, eq, notInArray } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  ApiError,
  newId,
  VERSION_KIND_LABEL,
  type ActorRef,
  type AnyProjectEvent,
  type Version,
  type VersionContent,
  type VersionDetail,
  type VersionKind,
  type VersionRestoreResult,
  type VersionTargetKind,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { documentVersions, versions } from '../../db/schema';
import { withLiveDocument } from '../../realtime/collab';
import { notFound, SYSTEM_ACTOR } from '../collab-common';
import { replaceContent } from '../documents/ydoc';
import { writeProjectFile } from '../files/service';
import { readNotebook, replaceNotebook } from '../notebooks/nbformat';
import {
  docFromState,
  hashOf,
  readCurrent,
  targetInfo,
  ydocContent,
  type CurrentState,
  type TargetInfo,
} from './content';

/**
 * 历史版本（API.md §2.18.1）：存、列、读、回滚，以及编辑时的自动快照。
 * 回滚不删任何版本：先把当前内容存成「回滚前备份」，再写回旧内容，最后把结果存成「回滚」版本。
 */
type VersionRow = typeof versions.$inferSelect;

type VersionMeta = Pick<
  VersionRow,
  | 'id'
  | 'projectId'
  | 'targetKind'
  | 'targetId'
  | 'kind'
  | 'note'
  | 'size'
  | 'createdBy'
  | 'createdAt'
>;

export function toVersion(row: VersionMeta): Version {
  return {
    id: row.id,
    projectId: row.projectId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    kind: row.kind,
    note: row.note,
    size: row.size,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

// 同一毫秒里连续存的版本（回滚前备份 → 回滚）要按创建顺序排
let lastMs = 0;
function nextVersionTime(): Date {
  const now = Math.max(Date.now(), lastMs + 1);
  lastMs = now;
  return new Date(now);
}

async function latestRow(
  ctx: AppContext,
  projectId: string,
  kind: VersionTargetKind,
  targetId: string,
): Promise<VersionRow | null> {
  const [row] = await ctx.db.db
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.projectId, projectId),
        eq(versions.targetKind, kind),
        eq(versions.targetId, targetId),
      ),
    )
    .orderBy(desc(versions.createdAt), desc(versions.id))
    .limit(1);
  return row ?? null;
}

/** 文档模块旧的 document_versions（版本管理上线前手动存的）：第一次列版本时搬进 versions，id 不变 */
async function adoptLegacyDocumentVersions(ctx: AppContext, info: TargetInfo): Promise<void> {
  const adopted = ctx.db.db
    .select({ id: versions.id })
    .from(versions)
    .where(and(eq(versions.targetKind, 'document'), eq(versions.targetId, info.id)));
  const legacy = await ctx.db.db
    .select()
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, info.id), notInArray(documentVersions.id, adopted)));
  for (const v of legacy) {
    const doc = docFromState(v.ydocState);
    const content = ydocContent(doc, 'document', info.docKind);
    doc.destroy();
    await ctx.db.db
      .insert(versions)
      .values({
        id: v.id,
        projectId: info.projectId,
        targetKind: 'document',
        targetId: info.id,
        kind: 'manual',
        note: v.label,
        state: v.ydocState,
        content,
        contentHash: hashOf(content),
        size: Buffer.byteLength(JSON.stringify(content), 'utf8'),
        createdBy: v.createdBy,
        createdAt: v.createdAt,
      })
      .onConflictDoNothing();
  }
}

/** 版本列表最多返回这么多条（更早的仍保留在库里） */
export async function listVersions(
  ctx: AppContext,
  projectId: string,
  kind: VersionTargetKind,
  targetId: string,
): Promise<Version[]> {
  const info = await targetInfo(ctx, projectId, kind, targetId);
  if (kind === 'document') await adoptLegacyDocumentVersions(ctx, info);
  // 列表不带快照本体（state / blob / content），只取元信息
  const rows = await ctx.db.db
    .select({
      id: versions.id,
      projectId: versions.projectId,
      targetKind: versions.targetKind,
      targetId: versions.targetId,
      kind: versions.kind,
      note: versions.note,
      size: versions.size,
      createdBy: versions.createdBy,
      createdAt: versions.createdAt,
    })
    .from(versions)
    .where(
      and(
        eq(versions.projectId, projectId),
        eq(versions.targetKind, kind),
        eq(versions.targetId, targetId),
      ),
    )
    .orderBy(desc(versions.createdAt), desc(versions.id));
  return rows.map(toVersion);
}

interface SaveOptions {
  kind: VersionKind;
  note?: string;
  /** 内容和最新版本一样时直接返回最新版本（不重复存）；手动保存默认 false */
  reuseIfSame?: boolean;
  current?: CurrentState;
}

/** 把对象当前内容存成一个版本，发 version.created */
export async function saveVersion(
  ctx: AppContext,
  actor: ActorRef,
  info: TargetInfo,
  opts: SaveOptions,
): Promise<{ version: Version; created: boolean }> {
  const cur = opts.current ?? (await readCurrent(ctx, info));
  const contentHash = hashOf(cur.content, cur.blob);
  if (opts.reuseIfSame) {
    const latest = await latestRow(ctx, info.projectId, info.kind, info.id);
    if (latest && latest.contentHash === contentHash) {
      return { version: toVersion(latest), created: false };
    }
  }
  const note = (opts.note ?? '').trim().slice(0, 200) || VERSION_KIND_LABEL[opts.kind];
  const event = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(versions)
      .values({
        id: newId('version'),
        projectId: info.projectId,
        targetKind: info.kind,
        targetId: info.id,
        kind: opts.kind,
        note,
        state: cur.state,
        blob: cur.blob,
        content: cur.content,
        contentHash,
        size: cur.size,
        createdBy: actor,
        createdAt: nextVersionTime(),
      })
      .returning();
    return ctx.bus.record(tx, {
      projectId: info.projectId,
      type: 'version.created',
      payload: toVersion(row!),
      actor,
    });
  });
  ctx.bus.emit(event);
  return { version: event.payload, created: true };
}

export async function createManualVersion(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  kind: VersionTargetKind,
  targetId: string,
  note: string,
): Promise<Version> {
  const info = await targetInfo(ctx, projectId, kind, targetId);
  return (await saveVersion(ctx, actor, info, { kind: 'manual', note })).version;
}

async function versionRow(ctx: AppContext, projectId: string, versionId: string) {
  const [row] = await ctx.db.db
    .select()
    .from(versions)
    .where(and(eq(versions.id, versionId), eq(versions.projectId, projectId)));
  if (!row) notFound('版本');
  return row;
}

export async function readVersion(
  ctx: AppContext,
  projectId: string,
  versionId: string,
): Promise<VersionDetail> {
  const row = await versionRow(ctx, projectId, versionId);
  return { version: toVersion(row), content: row.content as VersionContent };
}

export async function readCurrentContent(
  ctx: AppContext,
  projectId: string,
  kind: VersionTargetKind,
  targetId: string,
): Promise<VersionContent> {
  const info = await targetInfo(ctx, projectId, kind, targetId);
  return (await readCurrent(ctx, info)).content;
}

function fmtTime(d: Date): string {
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('month')}月${get('day')}日 ${get('hour')}:${get('minute')}`;
}

/** 把一个 Yjs 状态整体写回在线对象（在线的人实时看到） */
export async function writeBackState(
  ctx: AppContext,
  actor: ActorRef,
  info: TargetInfo,
  state: Uint8Array,
): Promise<void> {
  const source = docFromState(state);
  try {
    if (info.kind === 'document') {
      await withLiveDocument(ctx, info.id, actor, (doc) =>
        replaceContent(doc, source, info.docKind ?? 'doc'),
      );
    } else {
      const nb = readNotebook(source);
      await withLiveDocument(ctx, info.id, actor, (doc) => {
        doc.transact(() => replaceNotebook(doc, nb));
      });
    }
  } finally {
    source.destroy();
  }
}

/** 回滚到某个版本（回滚本身存成新版本） */
export async function restoreVersion(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  versionId: string,
): Promise<VersionRestoreResult> {
  const row = await versionRow(ctx, projectId, versionId);
  const info = await targetInfo(ctx, projectId, row.targetKind, row.targetId);
  if (info.archived) throw new ApiError('conflict', '文档已归档，恢复后才能回滚');
  if (info.kind === 'file' ? !row.blob : !row.state) {
    throw new ApiError('conflict', '这个版本只记录了大小，没有保存内容，不能回滚');
  }
  const label = `${fmtTime(row.createdAt)}「${row.note}」`;
  const backup = await saveVersion(ctx, actor, info, {
    kind: 'pre_restore',
    note: `回滚到 ${label} 之前的内容`,
    reuseIfSame: true,
  });
  if (info.kind === 'file') {
    await writeProjectFile(ctx, actor, projectId, info.path!, Buffer.from(row.blob!), info.mime);
  } else {
    await writeBackState(ctx, actor, info, row.state!);
  }
  const fresh = await targetInfo(ctx, projectId, info.kind, info.id);
  const restored = await saveVersion(ctx, actor, fresh, {
    kind: 'restore',
    note: `回滚到 ${label}`,
  });
  return { backup: backup.version, restored: restored.version };
}

// ---------------------------------------------------------------- 自动快照

/** 同一个对象两次自动快照之间至少隔这么久（文件每次写入都算一版，不节流） */
let autoIntervalMs = 5 * 60_000;
export function setAutoSnapshotInterval(ms: number) {
  autoIntervalMs = ms;
}

const lastAuto = new WeakMap<AppContext, Map<string, number>>();
const pending = new WeakMap<AppContext, Set<string>>();

function targetOfEvent(ev: AnyProjectEvent): { kind: VersionTargetKind; id: string } | null {
  const id = (ev.payload as { id?: unknown } | null)?.id;
  if (typeof id !== 'string') return null;
  switch (ev.type) {
    case 'document.created':
    case 'document.updated':
      return { kind: 'document', id };
    case 'notebook.created':
    case 'notebook.updated':
      return { kind: 'notebook', id };
    case 'file.created':
    case 'file.updated':
      return { kind: 'file', id };
    default:
      return null;
  }
}

async function autoSnapshot(
  ctx: AppContext,
  projectId: string,
  kind: VersionTargetKind,
  id: string,
  actor: ActorRef,
) {
  const key = `${kind}:${id}`;
  const times = lastAuto.get(ctx) ?? new Map<string, number>();
  lastAuto.set(ctx, times);
  const now = Date.now();
  if (kind !== 'file') {
    const last = times.get(key);
    if (last !== undefined && now - last < autoIntervalMs) return;
    if (last === undefined) {
      const latest = await latestRow(ctx, projectId, kind, id);
      if (latest && now - latest.createdAt.getTime() < autoIntervalMs) {
        times.set(key, latest.createdAt.getTime());
        return;
      }
    }
  }
  times.set(key, now);
  let info: TargetInfo;
  try {
    info = await targetInfo(ctx, projectId, kind, id);
  } catch {
    return; // 已删除
  }
  if (info.archived) return;
  await saveVersion(ctx, actor.kind === 'system' ? SYSTEM_ACTOR : actor, info, {
    kind: 'auto',
    reuseIfSame: true,
  });
}

/** 监听编辑事件做自动快照（在 register 里调一次） */
export function startAutoSnapshots(ctx: AppContext): void {
  const inflight = pending.get(ctx) ?? new Set<string>();
  pending.set(ctx, inflight);
  ctx.bus.onEvent((ev) => {
    const t = targetOfEvent(ev);
    if (!t) return;
    const key = `${t.kind}:${t.id}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    void autoSnapshot(ctx, ev.projectId, t.kind, t.id, ev.actor)
      .catch((err) => {
        // 测试或关机时数据库先关了：不算错误
        if (/closed/iu.test(String((err as { cause?: unknown }).cause ?? err))) return;
        console.error('[versioning] 自动快照失败', err);
      })
      .finally(() => inflight.delete(key));
  });
}

/** 测试与内部工具：Y 状态复制 */
export function cloneState(state: Uint8Array): Uint8Array {
  const d = docFromState(state);
  const out = Y.encodeStateAsUpdate(d);
  d.destroy();
  return out;
}
