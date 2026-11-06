import type {
  ResearchItem,
  ResearchItemSummary,
  ResearchLayoutUpdateInput,
  ResearchPosition,
} from '@srh/shared';
import { clientId } from '@/lib/client-id';
import { tr } from '@/lib/i18n';

export type LayoutMove = { id: string; position: ResearchPosition };
export type LayoutSave = (input: ResearchLayoutUpdateInput) => Promise<{ items: ResearchItem[] }>;
export type LayoutSaved = {
  before: LayoutMove[];
  after: ResearchItem[];
};
export type LayoutIssue = {
  id: string;
  status: 'error' | 'conflict';
  message: string;
  positions: { itemId: string; title: string; local: ResearchPosition; remote: ResearchPosition }[];
};
export type LayoutSnapshot = {
  items: ResearchItemSummary[];
  saving: boolean;
  issues: LayoutIssue[];
};
type Job = {
  id: string;
  moves: LayoutMove[];
  status: 'queued' | 'saving' | 'error' | 'conflict';
  message: string;
  submitted?: ResearchLayoutUpdateInput;
  before?: LayoutMove[];
  externalChange: boolean;
};
const samePosition = (a: ResearchPosition, b: ResearchPosition) => a.x === b.x && a.y === b.y;
const overlaps = (a: LayoutMove[], b: LayoutMove[]) => a.some((x) => b.some((y) => x.id === y.id));

/**
 * 服务器确认、在途请求和最新本地目标分开保存；重试复用原幂等键。
 * 相交批次排队，不相交批次可以并行；旧事件和响应不能覆盖本地目标。
 */
export class WorkspaceLayoutCoordinator {
  private confirmed = new Map<string, ResearchItemSummary>();
  private order: string[] = [];
  private jobs: Job[] = [];
  private listeners = new Set<() => void>();
  private snapshot: LayoutSnapshot;
  private save: LayoutSave;
  private onSaved?: (result: LayoutSaved) => void;

  constructor(
    items: ResearchItemSummary[],
    save: LayoutSave,
    onSaved?: (result: LayoutSaved) => void,
  ) {
    this.save = save;
    this.onSaved = onSaved;
    for (const item of items) this.confirmed.set(item.id, item);
    this.order = items.map((item) => item.id);
    this.snapshot = this.buildSnapshot();
  }

  configure(save: LayoutSave, onSaved?: (result: LayoutSaved) => void) {
    this.save = save;
    this.onSaved = onSaved;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  ingest(items: ResearchItemSummary[]) {
    const present = new Set(items.map((item) => item.id));
    const nextOrder = items.map((item) => item.id);
    let changed =
      nextOrder.length !== this.order.length ||
      nextOrder.some((id, index) => id !== this.order[index]);
    this.order = nextOrder;
    for (const item of items) {
      const old = this.confirmed.get(item.id);
      if (!old) {
        this.confirmed.set(item.id, item);
        changed = true;
        continue;
      }
      const newerPosition = item.positionVersion > old.positionVersion;
      const pending = this.jobs.filter((job) => job.moves.some((move) => move.id === item.id));
      if (newerPosition && pending.length) {
        const isOwnEvent = pending.some((job) => {
          const sent = job.submitted?.moves.find((move) => move.itemId === item.id);
          return (
            sent &&
            sent.basePositionVersion + 1 === item.positionVersion &&
            samePosition(sent.position, item.position)
          );
        });
        if (!isOwnEvent) {
          changed = true;
          for (const job of pending) {
            if (job.status === 'saving') job.externalChange = true;
            else {
              job.status = 'conflict';
              job.message = tr('布局已被他人修改，请选择保留的位置。');
            }
          }
        }
      }
      const content = item.version >= old.version ? item : old;
      const position = newerPosition ? item : old;
      const next = {
        ...content,
        position: position.position,
        positionVersion: position.positionVersion,
      };
      if (JSON.stringify(old) !== JSON.stringify(next)) {
        this.confirmed.set(item.id, next);
        changed = true;
      }
    }
    for (const id of this.confirmed.keys()) {
      if (!present.has(id) && !this.jobs.some((job) => job.moves.some((move) => move.id === id))) {
        this.confirmed.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.publish();
      this.pump();
    }
  }

  moveMany = (moves: LayoutMove[]) => {
    const current = new Map(this.snapshot.items.map((item) => [item.id, item.position]));
    const unique = new Map<string, ResearchPosition>();
    for (const move of moves) {
      const position = current.get(move.id);
      if (position && !samePosition(position, move.position)) unique.set(move.id, move.position);
    }
    if (!unique.size) return;
    let combined = [...unique].map(([id, position]) => ({ id, position }));
    // 只合并尚未发送的相交操作，已发送请求的幂等内容不可改。
    for (let index = 0; index < this.jobs.length;) {
      const job = this.jobs[index]!;
      if (job.status === 'queued' && overlaps(job.moves, combined)) {
        const merged = new Map(job.moves.map((move) => [move.id, move.position]));
        for (const move of combined) merged.set(move.id, move.position);
        combined = [...merged].map(([id, position]) => ({ id, position }));
        this.jobs.splice(index, 1);
        index = 0;
      } else index++;
    }
    this.jobs.push({
      id: clientId(),
      moves: combined,
      status: 'queued',
      message: '',
      externalChange: false,
    });
    this.publish();
    this.pump();
  };

  retry = (id: string) => {
    const job = this.jobs.find((entry) => entry.id === id && entry.status === 'error');
    if (!job) return;
    job.status = 'queued';
    job.message = '';
    this.publish();
    this.pump();
  };

  resolveMine = (id: string) => {
    const job = this.jobs.find((entry) => entry.id === id && entry.status === 'conflict');
    if (!job) return;
    job.status = 'queued';
    job.message = '';
    job.submitted = undefined;
    job.before = undefined;
    job.externalChange = false;
    this.publish();
    this.pump();
  };

  resolveTheirs = (id: string) => {
    const conflict = this.jobs.find((entry) => entry.id === id && entry.status === 'conflict');
    if (!conflict) return;
    // 保证后续重叠的整体移动不会在接受对方布局后自动覆盖它。
    const removed = new Set([conflict]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const job of this.jobs) {
        if (
          job.status !== 'saving' &&
          !removed.has(job) &&
          [...removed].some((x) => overlaps(x.moves, job.moves))
        ) {
          removed.add(job);
          changed = true;
        }
      }
    }
    this.jobs = this.jobs.filter((job) => !removed.has(job));
    this.publish();
    this.pump();
  };

  private buildSnapshot(): LayoutSnapshot {
    const positions = new Map<string, ResearchPosition>();
    for (const job of this.jobs)
      for (const move of job.moves) positions.set(move.id, move.position);
    return {
      items: this.order.flatMap((id) => {
        const item = this.confirmed.get(id);
        return item ? [{ ...item, position: positions.get(id) ?? item.position }] : [];
      }),
      saving: this.jobs.some((job) => job.status === 'saving' || job.status === 'queued'),
      issues: this.jobs
        .filter((job) => job.status === 'error' || job.status === 'conflict')
        .map((job) => ({
          id: job.id,
          status: job.status as 'error' | 'conflict',
          message: job.message,
          positions: job.moves.flatMap((move) => {
            const remote = this.confirmed.get(move.id);
            return remote
              ? [
                  {
                    itemId: move.id,
                    title: remote.title,
                    local: positions.get(move.id) ?? move.position,
                    remote: remote.position,
                  },
                ]
              : [];
          }),
        })),
    };
  }
  private publish() {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private pump() {
    const blocked: LayoutMove[][] = [];
    for (const job of this.jobs) {
      if (job.status !== 'queued') {
        blocked.push(job.moves);
        continue;
      }
      if (blocked.some((moves) => overlaps(moves, job.moves))) {
        blocked.push(job.moves);
        continue;
      }
      if (!job.submitted) {
        const entries = job.moves.map((move) => this.confirmed.get(move.id));
        if (entries.some((item) => !item)) {
          job.status = 'error';
          job.message = tr('部分内容已不存在，布局未保存。');
          blocked.push(job.moves);
          continue;
        }
        job.before = entries.map((item) => ({ id: item!.id, position: item!.position }));
        job.submitted = {
          idempotencyKey: clientId(),
          moves: job.moves.map((move, index) => ({
            itemId: move.id,
            position: move.position,
            basePositionVersion: entries[index]!.positionVersion,
          })),
        };
      }
      job.status = 'saving';
      blocked.push(job.moves);
      this.publish();
      void this.send(job);
    }
    this.publish();
  }

  private async send(job: Job) {
    try {
      const result = await this.save(job.submitted!);
      for (const item of result.items) this.acceptPosition(item);
      if (job.externalChange) {
        job.status = 'conflict';
        job.message = tr('布局已被他人修改，请选择保留的位置。');
      } else {
        this.jobs = this.jobs.filter((entry) => entry !== job);
        this.onSaved?.({ before: job.before ?? [], after: result.items });
      }
    } catch (error) {
      const candidate = error as {
        code?: string;
        details?: { current?: unknown };
        message?: string;
      };
      if (candidate?.code === 'version_conflict' && Array.isArray(candidate.details?.current)) {
        for (const item of candidate.details.current as ResearchItem[]) this.acceptPosition(item);
        job.status = 'conflict';
        job.message = tr('布局已被他人修改，请选择保留的位置。');
      } else {
        job.status = 'error';
        job.message = candidate?.message || tr('位置未保存，请重试。');
      }
    }
    this.publish();
    this.pump();
  }

  private acceptPosition(item: ResearchItem) {
    const old = this.confirmed.get(item.id);
    if (old && item.positionVersion > old.positionVersion)
      this.confirmed.set(item.id, {
        ...old,
        position: item.position,
        positionVersion: item.positionVersion,
        updatedAt: item.updatedAt,
      });
  }
}
