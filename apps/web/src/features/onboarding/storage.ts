/**
 * 新手引导与模块介绍的本地记录（localStorage）。
 * - 引导：每个用户 × 每个课题一条，`srh-onboarding:v1:<userId>:<projectId>`
 * - 模块介绍：每个用户 × 每个模块一条，`srh-intro:v1:<userId>:<module>`
 * 读写失败（隐私模式、配额满）时静默降级：引导照常可用，只是不记住进度。
 */

export type TourVariant = 'member' | 'advisor' | 'guest';
export type TourStatus = 'active' | 'done' | 'skipped';

export interface TourRecord {
  status: TourStatus;
  /** 最后停在第几步（从 0 开始） */
  step: number;
  variant: TourVariant;
  /** 导师欢迎框已经看过 */
  welcomed?: boolean;
  /** ISO 时间 */
  at: string;
}

export interface IntroRecord {
  /** 已经展示过几次（按进入页面计） */
  views: number;
  /** 点了“知道了” */
  dismissed: boolean;
}

/** 模块介绍最多自动出现几次 */
export const INTRO_MAX_VIEWS = 3;

const VARIANTS: readonly TourVariant[] = ['member', 'advisor', 'guest'];
const STATUSES: readonly TourStatus[] = ['active', 'done', 'skipped'];

export function tourKey(userId: string, projectId: string): string {
  return `srh-onboarding:v1:${userId}:${projectId}`;
}

export function introKey(userId: string, module: string): string {
  return `srh-intro:v1:${userId}:${module || 'home'}`;
}

/** 关掉自动引导与模块介绍（端到端测试、演示用）：localStorage['srh-onboarding:off'] = '1' */
export const ONBOARDING_OFF_KEY = 'srh-onboarding:off';

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略：只是记不住
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function readTourRecord(userId: string, projectId: string): TourRecord | null {
  const v = readJson(tourKey(userId, projectId));
  if (!isObject(v)) return null;
  const status = STATUSES.find((s) => s === v.status);
  const variant = VARIANTS.find((s) => s === v.variant);
  if (!status || !variant) return null;
  const step = typeof v.step === 'number' && Number.isFinite(v.step) ? Math.max(0, v.step) : 0;
  return {
    status,
    variant,
    step: Math.floor(step),
    at: typeof v.at === 'string' ? v.at : '',
    ...(v.welcomed === true ? { welcomed: true } : {}),
  };
}

export function writeTourRecord(
  userId: string,
  projectId: string,
  record: Omit<TourRecord, 'at'> & { at?: string },
): void {
  writeJson(tourKey(userId, projectId), { ...record, at: record.at ?? new Date().toISOString() });
}

export function readIntroRecord(userId: string, module: string): IntroRecord {
  const v = readJson(introKey(userId, module));
  if (!isObject(v)) return { views: 0, dismissed: false };
  return {
    views: typeof v.views === 'number' && v.views > 0 ? Math.floor(v.views) : 0,
    dismissed: v.dismissed === true,
  };
}

export function writeIntroRecord(userId: string, module: string, record: IntroRecord): void {
  writeJson(introKey(userId, module), record);
}

/** 这次进入页面要不要展示模块介绍（看过的次数是“这次之前”的）。 */
export function shouldShowIntro(record: IntroRecord): boolean {
  return !record.dismissed && record.views < INTRO_MAX_VIEWS;
}

// ---------------------------------------------------------------- 开关

export interface OnboardingConfig {
  /** 首次进入课题时自动开始引导 / 弹导师欢迎框 */
  autoStart: boolean;
  /** 模块页顶部的“这是什么、怎么用” */
  moduleIntro: boolean;
}

function defaultConfig(): OnboardingConfig {
  // 测试环境默认关掉，免得浮层挡住别的测试；需要时用 configureOnboarding 打开
  const enabled = import.meta.env.MODE !== 'test';
  return { autoStart: enabled, moduleIntro: enabled };
}

let config: OnboardingConfig = defaultConfig();

/** 注入开关（测试、嵌入场景）。传 null 恢复默认。 */
export function configureOnboarding(next: Partial<OnboardingConfig> | null): void {
  config = next === null ? defaultConfig() : { ...config, ...next };
}

function switchedOff(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_OFF_KEY) === '1';
  } catch {
    return false;
  }
}

export function autoStartEnabled(): boolean {
  return config.autoStart && !switchedOff();
}

export function moduleIntroEnabled(): boolean {
  return config.moduleIntro && !switchedOff();
}
