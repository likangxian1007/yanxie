import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { newId, type OpsLevel, type OpsSource } from '@srh/shared';
import type { Db } from '../db/client';
import { opsEvents } from '../db/schema';

/**
 * 运维事件采集（feat/feedback-center，管理后台「运维」页）。
 *
 * - 同一指纹（来源 + 规范化消息 + 栈顶一帧）合并为一行，累计 count、刷新 last_at；
 * - 同一指纹每分钟最多写一次库：窗口内的次数先在内存里攒着，下次写库时一起加上；
 * - 永不抛错：采集失败只打一行日志，绝不影响业务请求或 agent 收尾。
 */
export interface OpsEventInput {
  source: OpsSource;
  level?: OpsLevel;
  message: string;
  stack?: string;
  detail?: Record<string, unknown>;
  /** 自定义指纹；不给时按 source + 规范化消息 + 栈顶算 */
  fingerprint?: string;
}

export const OPS_WRITE_INTERVAL_MS = 60_000;
const MAX_TRACKED = 5_000;

/** fingerprint → { 上次写库时间, 窗口内还没写进去的次数 } */
const throttle = new Map<string, { lastWriteAt: number; pending: number }>();

/** 把消息里会变的部分（数字、id、十六进制、引号里的内容）抹掉，让同类错误落到同一指纹 */
export function normalizeOpsMessage(message: string): string {
  return message
    .replace(/\b[a-z]{2,6}_[0-9A-Za-z]{10,}\b/gu, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/giu, '<hex>')
    .replace(/\d+/gu, '<n>')
    .replace(/(["'`]).{0,200}?\1/gu, '<s>')
    .slice(0, 300);
}

function topFrame(stack: string | undefined): string {
  if (!stack) return '';
  const line = stack.split('\n').find((l) => /^\s*at\s/u.test(l));
  // 去掉行列号与绝对路径前缀，部署目录不同也能合并
  return (line ?? '')
    .trim()
    .replace(/:\d+:\d+\)?$/u, '')
    .replace(/\(?[A-Za-z]:\\.*[\\/]|\(?\/.*\//u, '');
}

export function opsFingerprint(input: Pick<OpsEventInput, 'source' | 'message' | 'stack'>): string {
  return createHash('sha1')
    .update(`${input.source}\n${normalizeOpsMessage(input.message)}\n${topFrame(input.stack)}`)
    .digest('hex')
    .slice(0, 20);
}

/** 测试用：清空节流表 */
export function resetOpsThrottle(): void {
  throttle.clear();
}

export async function recordOpsEvent(db: Db, input: OpsEventInput): Promise<void> {
  try {
    const fingerprint = input.fingerprint ?? opsFingerprint(input);
    const now = Date.now();
    const slot = throttle.get(fingerprint);
    if (slot && now - slot.lastWriteAt < OPS_WRITE_INTERVAL_MS) {
      slot.pending += 1;
      return;
    }
    const n = (slot?.pending ?? 0) + 1;
    if (throttle.size >= MAX_TRACKED && !slot) {
      // 只保留最近的；Map 按插入顺序，删最早的一个
      const oldest = throttle.keys().next().value;
      if (oldest !== undefined) throttle.delete(oldest);
    }
    throttle.delete(fingerprint);
    throttle.set(fingerprint, { lastWriteAt: now, pending: 0 });

    const message = input.message.slice(0, 2000);
    const detail: Record<string, unknown> = { ...(input.detail ?? {}) };
    if (input.stack) detail.stack = input.stack.slice(0, 8000);
    const at = new Date(now);
    await db
      .insert(opsEvents)
      .values({
        id: newId('opsEvent'),
        level: input.level ?? 'error',
        source: input.source,
        message,
        detail,
        fingerprint,
        count: n,
        firstAt: at,
        lastAt: at,
      })
      .onConflictDoUpdate({
        target: opsEvents.fingerprint,
        set: {
          count: sql`${opsEvents.count} + ${n}`,
          lastAt: at,
          message,
          detail,
          level: input.level ?? 'error',
        },
      });
  } catch (err) {
    console.error('[ops] 运维事件写入失败', (err as Error)?.message ?? err);
  }
}
