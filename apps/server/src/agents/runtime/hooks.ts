import type { Routine } from '@srh/shared';
import type { AppContext } from '../../context';

/**
 * REST 模块调用 agent 运行时的钩子。运行时启动时（agents/runtime/index.ts 的 startAgentRuntime）填入；
 * 没启动（测试、未配置 LLM）时为空，调用方按“什么都不做”处理。
 * 这样 REST 模块不需要直接 import 运行时，测试里也不会意外调用 LLM。
 */
export interface RuntimeHooks {
  /** 立即触发一次定时任务（POST P/routines/:id/run） */
  fireRoutine?: (ctx: AppContext, routine: Routine, actorUserId: string) => Promise<void>;
  /**
   * 中止某会话当前 turn，并把它从调度队列里拿掉（POST P/agents/:id/stop）。
   * 返回 true = 这一轮已经在跑（被中止）；false = 没在跑（可能只是排队）
   */
  stopSession?: (sessionId: string) => Promise<boolean>;
  /** 定时任务被增删改后重排计时器 */
  routinesChanged?: (projectId: string) => void;
  /** 立即压缩某会话的上下文（/compact）；返回是否真的压缩了 */
  compactSession?: (sessionId: string) => Promise<boolean>;
}

export const runtimeHooks: RuntimeHooks = {};
