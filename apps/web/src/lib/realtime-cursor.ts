/**
 * /ws 订阅的 seq 记账（纯逻辑，便于单测；RealtimeClient 持有一个实例）。
 *
 * 为什么需要：首屏数据来自 REST，WS 订阅要晚 1–3 秒才建立。如果订阅时传 afterSeq=0，
 * 服务端只推「订阅之后」的事件，中间这段时间的事件就永远丢了。所以订阅必须带一个
 * 「下界」：一个不晚于首屏数据的 seq，并要求服务端从这里补发（replay）。
 * 补发的事件里可能有首屏数据已经包含的，applyEvent 按 id 整体替换，重复应用没有副作用。
 *
 * 下界的来源（取最小值，越早越安全，多补发几条没关系）：
 * - 调用方给的 lowerBound：/auth/me 里该项目的 eventSeq（项目页的数据都在 me 返回之后才开始拉）
 * - 本标签页上次订阅这个项目时处理到的 seq：退订后缓存里的数据还停在那里
 */

export interface SubscribeArgs {
  afterSeq: number;
  /** true：afterSeq 是数据下界，即使为 0 也要补发 */
  replay: boolean;
}

export class SeqCursors {
  /** 正在订阅的项目 → 已处理的最大 seq；null 表示还没有任何下界（只要实时事件） */
  private readonly active = new Map<string, number | null>();
  /** 退订时记下的 seq：再次订阅时从这里补发 */
  private readonly lastSeen = new Map<string, number>();

  /** 开始（或重复）订阅，返回要发给服务端的参数。 */
  begin(projectId: string, lowerBound?: number): SubscribeArgs {
    if (this.active.has(projectId)) return this.argsFor(projectId);
    const candidates = [lowerBound, this.lastSeen.get(projectId)].filter(
      (n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0,
    );
    this.active.set(projectId, candidates.length ? Math.min(...candidates) : null);
    return this.argsFor(projectId);
  }

  /** 退订：记下处理到哪里，下次订阅从这里补发。 */
  end(projectId: string): boolean {
    if (!this.active.has(projectId)) return false;
    const seq = this.active.get(projectId);
    if (typeof seq === 'number') this.lastSeen.set(projectId, seq);
    this.active.delete(projectId);
    return true;
  }

  isActive(projectId: string): boolean {
    return this.active.has(projectId);
  }

  /** 当前的订阅参数（重连时重新订阅用）。 */
  argsFor(projectId: string): SubscribeArgs {
    const seq = this.active.get(projectId);
    return typeof seq === 'number'
      ? { afterSeq: seq, replay: true }
      : { afterSeq: 0, replay: false };
  }

  /** 所有正在订阅的项目及其参数。 */
  entries(): [string, SubscribeArgs][] {
    return [...this.active.keys()].map((id) => [id, this.argsFor(id)]);
  }

  /** 收到事件：返回 false 表示已经处理过（重复），不再分发。没订阅的项目不过滤。 */
  onEvent(projectId: string, seq: number): boolean {
    if (!this.active.has(projectId)) return true;
    const known = this.active.get(projectId);
    if (typeof known === 'number' && seq <= known) return false;
    this.active.set(projectId, seq);
    return true;
  }

  /**
   * subscribed / resync：服务端已经把 ≤ latestSeq 的事件补发完（或要求整体重拉），
   * 之后从 latestSeq 继续。
   */
  onCaughtUp(projectId: string, latestSeq: number): void {
    if (!this.active.has(projectId)) return;
    const known = this.active.get(projectId) ?? 0;
    this.active.set(projectId, Math.max(known, latestSeq));
  }

  /** 当前已处理到的 seq（测试与调试用）。 */
  seqOf(projectId: string): number | null | undefined {
    return this.active.has(projectId) ? this.active.get(projectId) : this.lastSeen.get(projectId);
  }
}
