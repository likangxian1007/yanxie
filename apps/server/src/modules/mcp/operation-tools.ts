import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiError } from '@srh/shared';
import { z } from 'zod';
import type { Operation, OperationCatalog } from '../integrations/catalog';

export interface OperationArguments {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
  transfer?:
    | { encoding: 'base64'; base64: string; fileId?: never }
    | { encoding: 'base64'; fileId: string; base64?: never }
    | {
        encoding: 'multipart';
        file: { filename: string; mimeType?: string; base64: string; fileId?: never };
        fields?: Record<string, string>;
      }
    | {
        encoding: 'multipart';
        file: { filename: string; mimeType?: string; fileId: string; base64?: never };
        fields?: Record<string, string>;
      };
}
export type OperationInvoker = (operation: Operation, args: OperationArguments) => Promise<unknown>;

/** Registers discovery and invocation over the same checked route registry as REST. */
export function registerOperationTools(
  server: McpServer,
  catalog: OperationCatalog,
  invoke: OperationInvoker,
  options: { readOnly: boolean },
): void {
  const result = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data ?? null) }],
  });
  const failure = (error: unknown) => {
    const body =
      error instanceof ApiError
        ? error.toBody().error
        : { code: 'internal', message: '操作失败，请稍后重试' };
    return { isError: true, ...result({ error: body }) };
  };
  const visible = () =>
    catalog
      .list()
      .filter((op) => op.access === 'open' && (!options.readOnly || op.effect === 'read'));
  const resolve = (id: string, mode: 'read' | 'write'): Operation => {
    const op = catalog.get(id);
    if (!op || op.access !== 'open') throw new ApiError('not_found', '操作不存在或不可用');
    if (mode === 'read' && op.effect !== 'read')
      throw new ApiError('forbidden', '该操作需要写入权限');
    if (mode === 'write' && (options.readOnly || op.effect === 'read')) {
      throw new ApiError('forbidden', '此操作不允许通过写入工具调用');
    }
    return op;
  };
  server.registerTool(
    'list_operations',
    {
      title: '发现可用操作',
      description: '按业务域、关键词和操作性质查找可用操作。',
      inputSchema: {
        domain: z.string().optional(),
        keyword: z.string().optional(),
        effect: z.enum(['read', 'write', 'execute']).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ domain, keyword, effect, offset, limit }) => {
      const matches = visible().filter(
        (op) =>
          (!domain || op.domain === domain) &&
          (!effect || op.effect === effect) &&
          (!keyword || `${op.id} ${op.description}`.toLowerCase().includes(keyword.toLowerCase())),
      );
      const start = offset ?? 0;
      const end = Math.min(start + (limit ?? 50), matches.length);
      return result({
        operations: matches
          .slice(start, end)
          .map(({ id, domain: opDomain, effect: opEffect, description }) => ({
            id,
            domain: opDomain,
            effect: opEffect,
            description,
          })),
        total: matches.length,
        offset: start,
        nextOffset: end < matches.length ? end : null,
      });
    },
  );
  server.registerTool(
    'describe_operation',
    {
      title: '查看操作契约',
      description: '获取操作路径、参数、权限和使用条件。',
      inputSchema: { operationId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ operationId }) => {
      const op = visible().find((item) => item.id === operationId);
      return op ? result(op) : failure(new ApiError('not_found', '操作不存在或不可用'));
    },
  );
  const inputSchema = {
    operationId: z.string().min(1),
    params: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.unknown()).optional(),
    body: z.unknown().optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,128}$/u)
      .optional(),
    transfer: z
      .union([
        z.object({
          encoding: z.literal('base64'),
          base64: z.string().max(27962028),
          fileId: z.never().optional(),
        }),
        z.object({
          encoding: z.literal('base64'),
          fileId: z.string().min(1),
          base64: z.never().optional(),
        }),
        z.object({
          encoding: z.literal('multipart'),
          file: z.object({
            filename: z.string().min(1).max(255),
            mimeType: z.string().max(200).optional(),
            base64: z.string().max(27962028),
            fileId: z.never().optional(),
          }),
          fields: z.record(z.string(), z.string()).optional(),
        }),
        z.object({
          encoding: z.literal('multipart'),
          file: z.object({
            filename: z.string().min(1).max(255),
            mimeType: z.string().max(200).optional(),
            fileId: z.string().min(1),
            base64: z.never().optional(),
          }),
          fields: z.record(z.string(), z.string()).optional(),
        }),
      ])
      .optional(),
  };
  server.registerTool(
    'read_operation',
    {
      title: '调用读取操作',
      description: '调用目录中开放的读取操作。',
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ operationId, ...args }) => {
      try {
        return result(await invoke(resolve(operationId, 'read'), args));
      } catch (error) {
        return failure(error);
      }
    },
  );
  if (!options.readOnly) {
    server.registerTool(
      'write_operation',
      {
        title: '调用写入或执行操作',
        description: '调用目录中开放的写入或执行操作。',
        inputSchema,
        annotations: { readOnlyHint: false },
      },
      async ({ operationId, ...args }) => {
        try {
          return result(await invoke(resolve(operationId, 'write'), args));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }
}
