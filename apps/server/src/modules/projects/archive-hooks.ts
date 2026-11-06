import type { AppContext } from '../../context';

/**
 * 项目删除（归档）后的清理钩子：内核容器、云电脑容器等按项目分配的资源在这里回收。
 * 终验 R2 #15：删除项目约 1 小时后，它的内核容器仍是 Up，云电脑容器留在 exited。
 *
 * 各模块在 register() 里调用 onProjectArchived(fn)；删除接口返回 204 后在后台依次执行，
 * 单个钩子失败只记日志，不影响其他钩子。
 */
export type ProjectArchiveHook = (ctx: AppContext, projectId: string) => Promise<void>;

const hooks = new Map<string, ProjectArchiveHook>();

/** name 用来去重（同一模块重复注册时覆盖）和打日志 */
export function onProjectArchived(name: string, fn: ProjectArchiveHook): void {
  hooks.set(name, fn);
}

export async function runProjectArchiveHooks(ctx: AppContext, projectId: string): Promise<void> {
  for (const [name, fn] of hooks) {
    try {
      await fn(ctx, projectId);
    } catch (err) {
      void ctx;
      console.warn(`[archive-hook ${name}] 项目 ${projectId} 归档后的清理失败`, err);
    }
  }
}

/** 测试用 */
export function resetProjectArchiveHooks(): void {
  hooks.clear();
}
