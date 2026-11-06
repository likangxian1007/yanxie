import type { ActorRef, AnyProjectEvent } from '@srh/shared';
import type { AppContext } from '../../context';
import { markSourcesForResource } from './service';

type UpstreamKind = 'file' | 'document' | 'notebook' | 'paper';
type UpstreamChange = { kind: UpstreamKind; id: string; deleted: boolean };

const SYSTEM_ACTOR: ActorRef = { kind: 'system', id: null, name: '上游资源变更' };
const active = new WeakMap<AppContext, () => void>();

function changedResource(event: AnyProjectEvent): UpstreamChange | null {
  switch (event.type) {
    case 'file.updated':
      return { kind: 'file', id: event.payload.id, deleted: false };
    case 'file.deleted':
      return { kind: 'file', id: event.payload.id, deleted: true };
    case 'document.updated':
      return { kind: 'document', id: event.payload.id, deleted: false };
    case 'document.deleted':
      return { kind: 'document', id: event.payload.id, deleted: true };
    case 'notebook.updated':
      return { kind: 'notebook', id: event.payload.id, deleted: false };
    case 'notebook.deleted':
      return { kind: 'notebook', id: event.payload.id, deleted: true };
    case 'paper.updated':
      return { kind: 'paper', id: event.payload.id, deleted: false };
    case 'paper.deleted':
      return { kind: 'paper', id: event.payload.id, deleted: true };
    default:
      return null;
  }
}

/** 上游对象变化只使对应来源和派生发现待复核；历史快照与摘录保持原样。 */
export function startResearchSourceHooks(ctx: AppContext): () => void {
  const existing = active.get(ctx);
  if (existing) return existing;

  // 同一上游对象的连续事件按序处理，避免并发写入来源版本互相覆盖。
  const pending = new Map<string, Promise<void>>();
  const off = ctx.bus.onEvent((event) => {
    const change = changedResource(event);
    if (!change) return;
    const key = `${event.projectId}:${change.kind}:${change.id}`;
    const previous = pending.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() =>
        markSourcesForResource(
          ctx,
          SYSTEM_ACTOR,
          event.projectId,
          change.kind,
          change.id,
          change.deleted,
        ),
      );
    pending.set(key, next);
    void next
      .catch((error: unknown) => {
        console.error('[research] 上游资源变更联动失败', error);
      })
      .finally(() => {
        if (pending.get(key) === next) pending.delete(key);
      });
  });

  const stop = () => {
    off();
    active.delete(ctx);
  };
  active.set(ctx, stop);
  return stop;
}
