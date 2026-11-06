import type { FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ApiError, newId } from '@srh/shared';
import { isAllowedOrigin } from '../../realtime/access';
import { authenticateBearer, bearerFromHeader, type BearerAuth } from '../integrations/service';
import type { ModuleDef } from '../types';
import { toolsFor, type McpToolCtx } from './tools';
import { operationCatalog } from '../../app';
import { invokeOperation } from '../integrations/runtime';
import { registerOperationTools } from './operation-tools';
import { apiOperationAudit } from '../../db/schema';

/**
 * 入站 MCP（API.md §2.22，ARCHITECTURE.md §16）。
 *
 *   POST   /mcp   JSON-RPC（initialize / tools/list / tools/call）；返回 application/json
 *   GET    /mcp   不开 SSE，按规范回 405
 *   DELETE /mcp   不管理会话，按规范回 405
 *
 * 与「出站 MCP」区分：`agents/mcp/manager.ts` 是我们去连别人的 MCP 服务器（客户端）；
 * 这里是别人（dots / Cursor / Claude 这类）来接我们（服务端）。
 *
 * 安全约定（改之前先读）：
 * 1. 端口只认 `Authorization: Bearer srh_pat_…`——**不接受 Cookie**。MCP 是机器入口，
 *    不让浏览器会话在这里被顺带使用，避免 CSRF 面扩大；身份链与 REST 完全同一套
 *    （`authenticateBearer`：未撤销、未过期、每令牌限流、记 last_used_at）。
 * 2. 每次请求校验 Origin（规范 MUST，防 DNS rebinding），规则与 /ws、/collab 相同。
 * 3. 只读令牌的工具清单里根本没有写工具（`toolsFor`），写工具还有一次兜底 + 每日额度。
 * 4. 无会话状态（stateless）：不签发 Mcp-Session-Id，避免多一层状态被人拿来串号。
 */
export const mcpModule: ModuleDef = {
  name: 'mcp',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;
    const ENDPOINT = '/mcp';

    /**
     * 401 一律带 WWW-Authenticate（MCP 规范 MUST）。
     * 注意：HTTP 头只能是 ASCII —— 中文说明放响应体，别放 error_description，否则 Node 会拒绝发送
     * （ERR_INVALID_CHAR，客户端会收到一个坏掉的 401）。
     */
    function challenge(reply: FastifyReply, invalid = false): void {
      const tail = invalid ? ', error="invalid_token"' : '';
      reply.header('WWW-Authenticate', `Bearer realm="srh"${tail}`);
    }

    function buildServer(auth: BearerAuth, raw: string, requestId: string): McpServer {
      const server = new McpServer({ name: 'srh', version: ctx.version });
      const tool: McpToolCtx = { ctx, user: auth.user, token: auth.token };
      const catalog = operationCatalog(ctx);
      const invoke = (
        operation: Parameters<typeof invokeOperation>[3],
        args: Parameters<typeof invokeOperation>[4],
      ) => invokeOperation(app, auth, raw, operation, args, requestId);
      registerOperationTools(server, catalog, invoke, {
        readOnly: !auth.token.scopes.includes('write'),
      });
      for (const def of toolsFor(auth.token)) {
        server.registerTool(
          def.name,
          {
            title: def.title,
            description: def.description,
            inputSchema: def.schema(),
            annotations: { readOnlyHint: !def.write, destructiveHint: false },
          },
          async (args: unknown) => {
            const input = (args ?? {}) as Record<string, unknown>;
            const target = Object.fromEntries(
              ['projectId', 'threadId', 'docId', 'itemId'].flatMap((key) =>
                typeof input[key] === 'string' ? [[key, String(input[key]).slice(0, 200)]] : [],
              ),
            );
            const startedAt = Date.now();
            try {
              let data: unknown;
              if (def.write) {
                const name = def.name;
                const operationId =
                  name === 'post_message'
                    ? input.threadId
                      ? 'POST /projects/:projectId/threads/:threadId/messages'
                      : 'POST /projects/:projectId/timeline'
                    : name === 'create_todo'
                      ? 'POST /projects/:projectId/todos'
                      : 'PATCH /inbox/:itemId';
                const op = catalog.get(operationId);
                if (!op) throw new ApiError('not_found', '操作未登记');
                const { projectId, threadId, itemId, idempotencyKey, ...body } = input;
                if (name === 'mark_inbox_done' && body.done === undefined) body.done = true;
                const response = (await invoke(op, {
                  params: {
                    ...(projectId ? { projectId: String(projectId) } : {}),
                    ...(threadId ? { threadId: String(threadId) } : {}),
                    ...(itemId ? { itemId: String(itemId) } : {}),
                  },
                  body,
                  ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
                })) as { data: unknown };
                data = response.data;
              } else {
                data = await def.run!(input, tool);
                await ctx.db.db.insert(apiOperationAudit).values({
                  id: newId('apiOperationAudit'),
                  requestId,
                  tokenId: auth.token.id,
                  userId: auth.user.id,
                  operationId: def.name,
                  target,
                  status: 200,
                  elapsedMs: Date.now() - startedAt,
                });
              }
              // 审计：谁（令牌）、调了什么工具、结果如何（ARCHITECTURE.md §16「所有调用记审计」）
              app.log.info(
                {
                  mcpTool: def.name,
                  tokenId: auth.token.id,
                  userId: auth.user.id,
                  ms: Date.now() - startedAt,
                  ok: true,
                },
                'mcp tool call',
              );
              return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
            } catch (err) {
              if (!def.write)
                await ctx.db.db.insert(apiOperationAudit).values({
                  id: newId('apiOperationAudit'),
                  requestId,
                  tokenId: auth.token.id,
                  userId: auth.user.id,
                  operationId: def.name,
                  target,
                  status: err instanceof ApiError ? err.status : 500,
                  errorCode: err instanceof ApiError ? err.code : 'internal',
                  elapsedMs: Date.now() - startedAt,
                });
              // 工具级错误：按 MCP 规矩返回 isError，不抛 500
              app.log.info(
                {
                  mcpTool: def.name,
                  tokenId: auth.token.id,
                  userId: auth.user.id,
                  ms: Date.now() - startedAt,
                  ok: false,
                  errorCode: err instanceof ApiError ? err.code : 'internal',
                },
                'mcp tool call failed',
              );
              const message =
                err instanceof ApiError ? err.message : '这个操作失败了，请稍后再试或到网页上操作';
              return {
                isError: true,
                content: [{ type: 'text' as const, text: message }],
                structuredContent: {
                  error:
                    err instanceof ApiError ? err.toBody().error : { code: 'internal', message },
                },
              };
            }
          },
        );
      }
      return server;
    }

    async function serve(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      // ---- 0. 只支持 POST：GET（SSE 流）与 DELETE（结束会话）按规范回 405。
      // 必须显式拦掉——stateless transport 收到带 Accept: text/event-stream 的 GET 会一直挂着不返回，
      // 客户端探测时就会卡死。
      if (req.method !== 'POST') {
        reply.header('Allow', 'POST');
        await reply.status(405).send({
          error: {
            code: 'method_not_allowed',
            message: '这个 MCP 端点只支持 POST：不提供 SSE 长连接，也不管理会话',
          },
        });
        return;
      }
      // ---- 1. 开关
      if (!ctx.config.MCP_ENABLED) {
        throw new ApiError(
          'forbidden',
          'MCP 接入未开启：请在服务器 .env 里设置 MCP_ENABLED=true 并重启',
        );
      }
      // ---- 2. 来源校验（规范 MUST，防 DNS rebinding）
      if (!isAllowedOrigin(req, ctx.config.PUBLIC_URL)) {
        throw new ApiError('forbidden', '请求来源不被允许');
      }
      // ---- 3. 只认 Bearer 令牌（不接受 Cookie 登录态）
      const raw = bearerFromHeader(req.headers.authorization);
      if (!raw) {
        challenge(reply);
        throw new ApiError(
          'unauthorized',
          'MCP 接入需要 API 令牌：Authorization: Bearer srh_pat_…（在「设置 → 接入」生成）',
        );
      }
      let auth: BearerAuth;
      try {
        if (!ctx.config.API_TOKENS_ENABLED) {
          throw new ApiError('unauthorized', 'API 令牌功能未开启（API_TOKENS_ENABLED）');
        }
        auth = await authenticateBearer(ctx, raw);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'unauthorized') challenge(reply, true);
        throw err;
      }

      // ---- 4. 交给 SDK 处理（stateless：每个请求一个 server + transport）
      const server = buildServer(auth, raw, req.id);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      // 从这里开始由我们直接写原始响应，Fastify 不再插手
      reply.hijack();
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        app.log.error({ err }, 'mcp request failed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        if (!reply.raw.writableEnded) {
          reply.raw.end(
            JSON.stringify({ error: { code: 'internal', message: '服务器出错了，请稍后再试' } }),
          );
        }
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    }

    app.post(ENDPOINT, serve);
    app.get(ENDPOINT, serve);
    app.delete(ENDPOINT, serve);
  },
};
