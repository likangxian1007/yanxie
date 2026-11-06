import { ApiError } from '@srh/shared';

/**
 * 登录 / 注册限流（进程内存，单实例部署够用；多实例需换成共享存储）。
 *
 * - 登录：按「规范化邮箱 + IP」计数，15 分钟内失败 5 次，之后这个邮箱从这个 IP 的尝试
 *   （即使密码正确）一律 429；登录成功清零该组合的计数。
 *   不按 IP 单独卡 5 次：整个实验室常在同一个 NAT 后面，一个人输错不能把全组锁在门外；
 *   也不按邮箱全局计：否则任何人都能从别处把受害者的账号锁住。
 * - 防撒网（一个 IP 试很多邮箱）：同一 IP 15 分钟内失败 100 次 → 该 IP 全部 429。
 * - 注册：同一 IP 每小时最多 50 次（实验室集中开账号也够用）。
 * - 找回密码：同一邮箱 15 分钟 3 次、同一 IP 15 分钟 20 次（不管邮箱是否注册都计数）。
 * - 429 的中文提示写明还要等多久，details.retryAfterSec / retryAfter 与 Retry-After 头给出秒数。
 *
 * 计数用滑动窗口（每个 key 只保留最近 limit 个时间戳），Map 有上限，超出时先清过期再按插入顺序淘汰。
 * 每个应用实例（buildApp）各有一个限流器，测试之间互不影响。
 */
export interface RateLimitOptions {
  /** 同一「邮箱 + IP」窗口内允许的登录失败次数 */
  loginFailuresPerEmailIp: number;
  /** 同一 IP（所有邮箱合计）窗口内允许的登录失败次数，远高于上一项，只防撒网 */
  loginFailuresPerIp: number;
  loginWindowMs: number;
  /** 同一 IP 窗口内允许的注册次数 */
  registerPerIp: number;
  registerWindowMs: number;
  /** 同一邮箱窗口内允许的找回密码申请次数（不论邮箱是否注册都计，不泄露账号是否存在） */
  resetPerEmail: number;
  /** 同一 IP 窗口内允许的找回密码申请次数 */
  resetPerIp: number;
  resetWindowMs: number;
  /** 每张计数表最多保留的 key 数 */
  maxKeys: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitOptions = {
  loginFailuresPerEmailIp: 5,
  loginFailuresPerIp: 100,
  loginWindowMs: 15 * 60 * 1000,
  registerPerIp: 50,
  registerWindowMs: 60 * 60 * 1000,
  resetPerEmail: 3,
  resetPerIp: 20,
  resetWindowMs: 15 * 60 * 1000,
  maxKeys: 10_000,
};

/** 当前进程里所有应用实例的限流器，供 resetRateLimits 清空 */
const live = new Set<AuthRateLimiter>();
/** 测试覆盖的限额（setRateLimitOverridesForTests） */
let testOverrides: Partial<RateLimitOptions> | null = null;

/** 滑动窗口计数器：key → 窗口内的时间戳（升序，最多 limit 个） */
export class WindowCounter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
  ) {}

  private live(key: string, now: number): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    const fresh = list.filter((t) => now - t < this.windowMs);
    if (fresh.length === 0) this.hits.delete(key);
    else if (fresh.length !== list.length) this.hits.set(key, fresh);
    return fresh;
  }

  /** 已达上限时返回还要等多少秒，否则 null */
  blockedFor(key: string, now = Date.now()): number | null {
    if (!Number.isFinite(this.limit)) return null;
    const list = this.live(key, now);
    if (list.length < this.limit) return null;
    const oldest = list[list.length - this.limit]!;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  hit(key: string, now = Date.now()): void {
    if (!Number.isFinite(this.limit)) return;
    const list = this.live(key, now);
    list.push(now);
    if (list.length > this.limit) list.splice(0, list.length - this.limit);
    this.hits.delete(key); // 重新插入，Map 的迭代顺序即最近使用顺序
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.prune(now);
  }

  /** 撤销最近一次计数（登录成功时把预占的 IP 计数还回去） */
  undo(key: string): void {
    const list = this.hits.get(key);
    if (!list) return;
    list.pop();
    if (list.length === 0) this.hits.delete(key);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  clear(): void {
    this.hits.clear();
  }

  get size(): number {
    return this.hits.size;
  }

  private prune(now: number): void {
    for (const key of [...this.hits.keys()]) this.live(key, now);
    // 仍然超出：按最久未使用淘汰
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

export interface AuthRateLimiter {
  /**
   * 登录前调用：已被限流则抛 429；否则预先记一次失败（并发请求也会被计入），
   * 成功后调用 loginSucceeded 撤销。
   */
  beginLogin(email: string, ip: string): void;
  loginSucceeded(email: string, ip: string): void;
  /** 注册前调用：超限抛 429，否则计一次 */
  beginRegister(ip: string): void;
  /** 找回密码申请前调用：邮箱或 IP 超限抛 429，否则两边各计一次 */
  beginPasswordReset(email: string, ip: string): void;
  clear(): void;
}

function rateLimited(message: string, retryAfterSec: number): ApiError {
  // retryAfterSec 是原有字段；retryAfter 同值，方便前端统一读取
  return new ApiError('rate_limited', message, { retryAfterSec, retryAfter: retryAfterSec });
}

/** 等待时长的中文说法：不到 1 分钟按秒，否则向上取整到分钟 */
export function waitText(sec: number): string {
  const s = Math.max(1, Math.ceil(sec));
  return s < 60 ? `${s} 秒` : `${Math.ceil(s / 60)} 分钟`;
}

/** 邮箱 + IP 的组合 key（邮箱已由调用方规范化） */
const emailIpKey = (email: string, ip: string) => `${email}\u0000${ip}`;

export function createAuthRateLimiter(overrides: Partial<RateLimitOptions> = {}): AuthRateLimiter {
  const o = { ...DEFAULT_RATE_LIMITS, ...overrides };
  const byEmailIp = new WindowCounter(o.loginFailuresPerEmailIp, o.loginWindowMs, o.maxKeys);
  const byIp = new WindowCounter(o.loginFailuresPerIp, o.loginWindowMs, o.maxKeys);
  const registerByIp = new WindowCounter(o.registerPerIp, o.registerWindowMs, o.maxKeys);
  const resetByEmail = new WindowCounter(o.resetPerEmail, o.resetWindowMs, o.maxKeys);
  const resetByIp = new WindowCounter(o.resetPerIp, o.resetWindowMs, o.maxKeys);
  const limiter: AuthRateLimiter = {
    beginLogin(email, ip) {
      const now = Date.now();
      const key = emailIpKey(email, ip);
      const wait = Math.max(byEmailIp.blockedFor(key, now) ?? 0, byIp.blockedFor(ip, now) ?? 0);
      if (wait > 0) {
        throw rateLimited(`登录尝试过多，请 ${waitText(wait)}后再试`, wait);
      }
      byEmailIp.hit(key, now);
      byIp.hit(ip, now);
    },
    loginSucceeded(email, ip) {
      byEmailIp.reset(emailIpKey(email, ip));
      byIp.undo(ip);
    },
    beginRegister(ip) {
      const wait = registerByIp.blockedFor(ip);
      if (wait !== null) {
        throw rateLimited(`注册太频繁，请 ${waitText(wait)}后再试`, wait);
      }
      registerByIp.hit(ip);
    },
    beginPasswordReset(email, ip) {
      const now = Date.now();
      const wait = Math.max(
        resetByEmail.blockedFor(email, now) ?? 0,
        resetByIp.blockedFor(ip, now) ?? 0,
      );
      if (wait > 0) {
        // 单位写死在文案里，英文词典才能整句翻译（不带中文单位）
        const s = Math.max(1, Math.ceil(wait));
        throw rateLimited(
          s < 60
            ? `重置请求太频繁，请 ${s} 秒后再试`
            : `重置请求太频繁，请 ${Math.ceil(s / 60)} 分钟后再试`,
          wait,
        );
      }
      resetByEmail.hit(email, now);
      resetByIp.hit(ip, now);
    },
    clear() {
      byEmailIp.clear();
      byIp.clear();
      registerByIp.clear();
      resetByEmail.clear();
      resetByIp.clear();
    },
  };
  live.add(limiter);
  return limiter;
}

// ---------------------------------------------------------------- 测试钩子

/** 应用关闭时调用，避免测试里反复建应用导致集合增长 */
export function releaseRateLimiter(limiter: AuthRateLimiter): void {
  live.delete(limiter);
}

/** 仅测试用：之后新建的应用使用这些限额（null 恢复默认） */
export function setRateLimitOverridesForTests(o: Partial<RateLimitOptions> | null): void {
  testOverrides = o;
}

/** 仅测试用：清空所有限流计数 */
export function resetRateLimits(): void {
  for (const l of live) l.clear();
}

/**
 * 按运行环境决定限额：测试环境默认不限注册（大量用例从同一 IP 注册用户），
 * 登录限流保持开启；测试可用 setRateLimitOverridesForTests 覆盖。
 */
export function rateLimitOptionsFor(nodeEnv: string): Partial<RateLimitOptions> {
  return {
    ...(nodeEnv === 'test' ? { registerPerIp: Number.POSITIVE_INFINITY } : {}),
    ...(testOverrides ?? {}),
  };
}
