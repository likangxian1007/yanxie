#!/usr/bin/env node
/* global process, Buffer, console, fetch */
// Node.js 22.12+; deliberately reads only explicitly supplied environment variables.
import { randomUUID } from 'node:crypto';

const root = process.env.SRH_URL;
const token = process.env.SRH_TOKEN;
const write = process.argv.includes('--write');
const message = process.argv.includes('--message');
if (!root || !token || (message && !write)) {
  console.error('请提供 SRH_URL、SRH_TOKEN；--message 需要同时指定 --write。');
  process.exit(1);
}
const endpoint = `${root.replace(/\/$/u, '')}/api/v1/mcp`;
let requestId = 0;
async function rpc(method, params) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
  const response = await res.json();
  if (response.error) throw new Error(`MCP: ${response.error.message}`);
  return response.result;
}
async function tool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args });
  const text = result.content?.find((item) => item.type === 'text')?.text ?? 'null';
  if (result.isError) {
    let detail;
    try {
      detail = JSON.parse(text).error;
    } catch {
      detail = result.structuredContent?.error;
    }
    throw new Error(`${detail?.code ?? 'tool_error'}: ${detail?.message ?? text}`);
  }
  return JSON.parse(text);
}
async function operation(name, args) {
  const result = await tool(name, args);
  if (!result.segmented) return result.data;
  const chunks = [];
  let part = result.data;
  const mime = part.mimeType;
  for (;;) {
    chunks.push(Buffer.from(part.base64, 'base64'));
    if (part.nextOffset === null) break;
    part = (
      await tool('read_operation', {
        operationId: part.continuationOperation ?? 'GET /integrations/results/:resultId/chunks',
        params: { resultId: part.resultId },
        query: { offset: part.nextOffset },
      })
    ).data;
  }
  const bytes = Buffer.concat(chunks);
  return mime.includes('json') ? JSON.parse(bytes.toString('utf8')) : bytes;
}

try {
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'srh-workflow-example', version: '1.0.0' },
  });
  let offset = 0;
  let count = 0;
  do {
    const page = await tool('list_operations', { offset, limit: 100 });
    count += page.operations.length;
    offset = page.nextOffset;
  } while (offset !== null);
  console.log(`可用操作：${count}`);
  const projects = await tool('list_projects');
  const project = process.env.SRH_PROJECT_ID
    ? projects.find((p) => p.id === process.env.SRH_PROJECT_ID)
    : projects[0];
  if (!project) throw new Error('没有可访问的项目，或 SRH_PROJECT_ID 不在令牌范围内');
  const projectId = project.id;
  const operationId = 'GET /projects/:projectId';
  await tool('describe_operation', { operationId });
  const data = await operation('read_operation', { operationId, params: { projectId } });
  console.log(`已读取项目：${data.name} (${projectId})`);
  if (write) {
    const todo = await operation('write_operation', {
      operationId: 'POST /projects/:projectId/todos',
      params: { projectId },
      body: { title: '个人 Agent 接入示例' },
      idempotencyKey: randomUUID(),
    });
    await operation('write_operation', {
      operationId: 'PATCH /projects/:projectId/todos/:todoId',
      params: { projectId, todoId: todo.id },
      body: { done: true },
      idempotencyKey: randomUUID(),
    });
    console.log(`已创建并完成示例待办：${todo.id}`);
    if (message) {
      await operation('write_operation', {
        operationId: 'POST /projects/:projectId/timeline',
        params: { projectId },
        body: { body: '个人 Agent 已完成接入示例。', agentVisible: false },
        idempotencyKey: randomUUID(),
      });
      console.log('已写入示例消息（不唤醒站内 Agent）。');
    }
  } else console.log('只读演示完成；传 --write 才会创建并完成示例待办。');
} catch (error) {
  console.error(error instanceof Error ? error.message : '请求失败');
  process.exitCode = 1;
}
