import type { FastifyInstance } from 'fastify';

/**
 * 业务模块约定：
 * - 一个模块一个目录：modules/<name>/index.ts 导出 ModuleDef，路由、service、serialize 放同目录。
 * - register 里注册的路由自动挂在 /api/v1 下（见 app.ts），路径写相对的，如 `/projects/:projectId/docs`。
 * - 只通过 app.ctx 拿 db / bus / config；写操作后必须 bus.publish 对应事件（见 API.md §3）。
 * - 模块之间不互相 import 路由；需要复用的逻辑放 service.ts 并显式导出。
 */
export interface ModuleDef {
  name: string;
  /** 负责的线程，避免并行开发时互相踩文件 */
  owner: 'foundation' | 'backend' | 'collab' | 'library';
  register: (app: FastifyInstance) => Promise<void> | void;
}
