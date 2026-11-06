// 测试用的最小 MCP stdio 服务器：echo（回显）+ fail（返回 isError）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'echo', version: '0.0.1' },
  { instructions: '测试用回显服务器。' },
);
server.registerTool(
  'echo',
  { description: '原样返回 text', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);
server.registerTool('fail', { description: '总是失败', inputSchema: {} }, async () => ({
  isError: true,
  content: [{ type: 'text', text: '故意失败' }],
}));
await server.connect(new StdioServerTransport());
