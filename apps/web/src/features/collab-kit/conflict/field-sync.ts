import { deepEqual } from './merge';
import { tr } from '@/lib/i18n';

/**
 * 字段级乐观并发（卡片、实验记录、汇报共用；与 React 无关，便于单测）。
 *
 * 规则（ARCHITECTURE §5.2）：
 * - 某个字段第一次被改时，记下它的「草稿基线」：当时服务端的值 base 和版本 baseVersion。
 *   之后每次成功保存，基线前移到保存结果。
 * - 别人的实时更新只进缓存，不覆盖正在编辑的字段：界面显示 mine，并提示「对方刚更新了这个字段」。
 * - 保存时 baseVersion = 草稿基线（多个字段取最早的），而不是被实时事件推高过的缓存版本，
 *   所以只要中间有人改过，服务端一定 409。
 * - 409 后按字段三方比较：对方没动这个字段（current = base）→ 自动换基线重发；
 *   对方改成了和我一样 → 视为已保存；否则进入冲突，等用户选「保留我的 / 用对方的 / 手动合并」。
 *   冲突期间我的输入一直保留，绝不静默丢弃。
 */

export type SyncStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

export interface FieldSyncOptions<T extends { version: number }> {
  /** 当前已知的服务端对象（查询缓存）；undefined = 还没加载或已删除 */
  getServer: () => T | undefined;
  /** 发 PATCH：只含改动字段 + baseVersion；成功返回保存后的对象，版本冲突时抛错 */
  send: (patch: Partial<T>, baseVersion: number) => Promise<T>;
  /** 错误是 409 version_conflict 时返回 details.current，否则 null */
  conflictCurrent: (err: unknown) => T | null;
  /** 拿到服务端对象（保存结果 / 409 的最新对象）后写进缓存；force = 不比版本直接覆盖 */
  onServer: (obj: T, force: boolean) => void;
  /** 非冲突错误（网络、404…）；改动保留，可以重试 */
  onError?: (err: unknown) => void;
  /** 防抖毫秒（默认 800） */
  delay?: number;
  /** 409 后自动换基线重发的次数上限（默认 3） */
  maxRebase?: number;
}

interface Entry {
  base: unknown;
  baseVersion: number;
  mine: unknown;
  conflict: boolean;
}

export interface FieldConflict<V> {
  mine: V;
  theirs: V;
  base: V;
}

export interface FieldView<V> {
  /** 界面该显示的值：有草稿显示草稿，否则服务端值 */
  value: V;
  /** 服务端（缓存里）现在的值 */
  serverValue: V;
  /** 有没保存的本地改动 */
  dirty: boolean;
  /** 编辑期间对方改过这个字段（还没撞上 409） */
  remoteChanged: boolean;
  /** 已确认冲突：等用户选择 */
  conflict: FieldConflict<V> | null;
}

export class FieldSync<T extends { version: number }> {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | null = null;
  private again = false;
  private rev = 0;
  private lastStatus: Exclude<SyncStatus, 'conflict'> = 'idle';
  error: unknown = null;
  savedAt: string | null = null;
  /** 最近一个改过这条记录的其他人（实时事件里的 actor 名字） */
  remoteActor: string | null = null;

  constructor(private readonly opts: FieldSyncOptions<T>) {}

  // ---------------------------------------------------------------- 订阅（useSyncExternalStore）

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getRevision = (): number => this.rev;

  private notify() {
    this.rev += 1;
    for (const fn of [...this.listeners]) fn();
  }

  // ---------------------------------------------------------------- 读

  get status(): SyncStatus {
    if ([...this.entries.values()].some((e) => e.conflict)) return 'conflict';
    return this.lastStatus;
  }

  hasUnsaved(): boolean {
    return this.entries.size > 0;
  }

  conflictFields(): string[] {
    return [...this.entries].filter(([, e]) => e.conflict).map(([f]) => f);
  }

  field<K extends keyof T & string>(key: K, server: T | undefined = this.opts.getServer()) {
    const e = this.entries.get(key);
    const serverValue = server?.[key] as T[K];
    const view: FieldView<T[K]> = {
      value: e ? (e.mine as T[K]) : serverValue,
      serverValue,
      dirty: Boolean(e),
      remoteChanged: Boolean(e && !e.conflict && server && !deepEqual(serverValue, e.base)),
      conflict: e?.conflict
        ? { mine: e.mine as T[K], theirs: serverValue, base: e.base as T[K] }
        : null,
    };
    return view;
  }

  /** 服务端对象叠上本地草稿 */
  view(server: T): T {
    if (!this.entries.size) return server;
    const out = { ...server } as Record<string, unknown>;
    for (const [f, e] of this.entries) out[f] = e.mine;
    return out as T;
  }

  // ---------------------------------------------------------------- 写

  /** 本地改了一个字段；immediate = 立刻保存（选择类控件、失焦） */
  edit<K extends keyof T & string>(key: K, value: T[K], opts?: { immediate?: boolean }) {
    const server = this.opts.getServer();
    if (!server) return;
    const e = this.entries.get(key);
    if (e) e.mine = value;
    else {
      this.entries.set(key, {
        base: server[key],
        baseVersion: server.version,
        mine: value,
        conflict: false,
      });
    }
    if (!this.entries.get(key)?.conflict) this.lastStatus = 'pending';
    this.notify();
    this.schedule(opts?.immediate ?? false);
  }

  /** 冲突：保留我的（以对方的最新版本为基线，覆盖之） */
  keepMine(key: string) {
    const server = this.opts.getServer();
    const e = this.entries.get(key);
    if (!server || !e) return;
    e.conflict = false;
    e.base = (server as Record<string, unknown>)[key];
    e.baseVersion = server.version;
    this.lastStatus = 'pending';
    this.notify();
    this.schedule(true);
  }

  /** 冲突：用对方的（丢掉自己的草稿——这是用户明确的选择） */
  takeTheirs(key: string) {
    if (!this.entries.delete(key)) return;
    this.notify();
  }

  /** 冲突：手动合并后的结果 */
  resolveWith<K extends keyof T & string>(key: K, value: T[K]) {
    const e = this.entries.get(key);
    if (!e) return;
    e.mine = value;
    this.keepMine(key);
  }

  /** 丢掉某个字段的草稿（例如 Esc 取消编辑） */
  discard(key: string) {
    const e = this.entries.get(key);
    if (!e || e.conflict) return;
    this.entries.delete(key);
    this.notify();
  }

  /**
   * 服务端对象变了（实时事件 / 重新拉取）：
   * 已与服务端一致的草稿收起；对方没动的字段把基线版本前移（省掉一次 409 往返）。
   */
  refresh(server: T | undefined = this.opts.getServer()) {
    if (!server || !this.entries.size) return;
    if (this.advance(server)) this.notify();
  }

  private advance(server: T): boolean {
    let changed = false;
    const s = server as Record<string, unknown>;
    for (const [f, e] of this.entries) {
      if (deepEqual(s[f], e.mine) && !this.inflight) {
        this.entries.delete(f);
        changed = true;
      } else if (!e.conflict && deepEqual(s[f], e.base) && server.version > e.baseVersion) {
        e.baseVersion = server.version;
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------- 保存

  private schedule(immediate: boolean) {
    this.clearTimer();
    if (immediate) {
      void this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.opts.delay ?? 800);
  }

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose() {
    this.clearTimer();
  }

  /** 立刻把待发的改动发出去（在途时等它结束再接着发） */
  flush(): Promise<void> {
    this.clearTimer();
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(): Promise<void> {
    let rebases = 0;
    for (;;) {
      this.again = false;
      const server = this.opts.getServer();
      if (!server) return;
      const s = server as Record<string, unknown>;
      for (const [f, e] of this.entries) {
        if (!e.conflict && deepEqual(e.mine, s[f])) this.entries.delete(f);
      }
      const sending = [...this.entries].filter(([, e]) => !e.conflict);
      if (!sending.length) {
        if (this.lastStatus === 'pending' || this.lastStatus === 'saving') {
          this.lastStatus = this.savedAt ? 'saved' : 'idle';
        }
        this.notify();
        return;
      }
      const patch: Record<string, unknown> = {};
      let baseVersion = Number.POSITIVE_INFINITY;
      for (const [f, e] of sending) {
        patch[f] = e.mine;
        baseVersion = Math.min(baseVersion, e.baseVersion);
      }
      this.lastStatus = 'saving';
      this.notify();
      let saved: T;
      try {
        saved = await this.opts.send(patch as Partial<T>, baseVersion);
      } catch (err) {
        const current = this.opts.conflictCurrent(err);
        if (!current) {
          this.lastStatus = 'error';
          this.error = err;
          this.notify();
          this.opts.onError?.(err);
          return;
        }
        this.opts.onServer(current, true);
        const c = current as Record<string, unknown>;
        for (const [f, e] of sending) {
          if (this.entries.get(f) !== e) continue;
          if (deepEqual(c[f], e.mine)) this.entries.delete(f);
          else if (deepEqual(c[f], e.base)) e.baseVersion = current.version;
          else e.conflict = true;
        }
        for (const [f, e] of this.entries) {
          if (!e.conflict && !(f in patch) && deepEqual(c[f], e.base)) {
            e.baseVersion = Math.max(e.baseVersion, current.version);
          }
        }
        this.notify();
        rebases += 1;
        if (rebases > (this.opts.maxRebase ?? 3)) {
          this.lastStatus = 'error';
          this.error = new Error(tr('这条记录一直在被别人修改，请稍后再保存。'));
          this.notify();
          return;
        }
        continue;
      }
      this.opts.onServer(saved, false);
      const v = saved as Record<string, unknown>;
      for (const [f, e] of sending) {
        if (this.entries.get(f) !== e) continue;
        if (deepEqual(e.mine, patch[f])) this.entries.delete(f);
        else {
          // 在途期间又改了：基线前移到这次保存的结果
          e.base = v[f];
          e.baseVersion = saved.version;
        }
      }
      // 这次没发的字段：服务端上它们没变，基线版本也可以前移
      for (const [f, e] of this.entries) {
        if (!e.conflict && !(f in patch) && deepEqual(v[f], e.base)) {
          e.baseVersion = Math.max(e.baseVersion, saved.version);
        }
      }
      this.error = null;
      this.savedAt = new Date().toISOString();
      this.lastStatus = this.timer !== undefined ? 'pending' : 'saved';
      this.notify();
      if (!this.again) return;
    }
  }
}
