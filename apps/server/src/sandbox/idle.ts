/**
 * 空闲回收：按 key 记录最后活跃时间，超过 idleMs 没有 touch 就回调 onIdle（通常是停容器）。
 * busy(key) 返回 true 的项不会被回收（例如内核正在执行）。
 */
export class IdleReaper {
  private readonly last = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly idleMs: number,
    private readonly onIdle: (key: string) => Promise<void> | void,
    private readonly busy: (key: string) => boolean = () => false,
    checkEveryMs = Math.min(60_000, Math.max(1000, Math.floor(idleMs / 4))),
  ) {
    if (idleMs > 0) {
      this.timer = setInterval(() => void this.sweep(), checkEveryMs);
      this.timer.unref?.();
    }
  }

  touch(key: string) {
    this.last.set(key, Date.now());
  }

  forget(key: string) {
    this.last.delete(key);
  }

  async sweep(now = Date.now()) {
    for (const [key, at] of [...this.last]) {
      if (now - at < this.idleMs || this.busy(key)) continue;
      this.last.delete(key);
      try {
        await this.onIdle(key);
      } catch {
        /* 回收失败下次再试不到了：key 已删除，下次使用会重新 touch */
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
