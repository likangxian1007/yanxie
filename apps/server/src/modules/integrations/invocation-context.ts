import { AsyncLocalStorage } from 'node:async_hooks';
import type { BearerAuth } from './service';

/** 仅服务端内部调用能创建，永远不根据 HTTP 头跳过校验。 */
export const operationInvocation = new AsyncLocalStorage<{
  auth: BearerAuth;
  method: string;
  url: string;
  requestId?: string;
}>();
