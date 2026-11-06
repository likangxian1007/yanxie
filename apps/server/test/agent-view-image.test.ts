import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startAgentRuntime } from '../src/agents/runtime';
import type { ChatModel, ChatResult, ChatToolCall } from '../src/agents/llm/complete';
import { clearVisionCache } from '../src/agents/vision';
import { setOcrEngineForTests } from '../src/agents/vision/ocr';
import { encodePng } from '../src/agents/vision/png';
import { writeProjectFile } from '../src/modules/files/service';
import { SYSTEM_ACTOR } from '../src/modules/projects/service';
import { makeApp, setupProject } from './helpers';

/** view_image：配置了视觉模型时走 image_url；否则走 OCR（这里换成假的 OCR 引擎），并如实说明 */
let seq = 0;
const call = (name: string, args: unknown): ChatToolCall => ({
  id: `call_${++seq}`,
  name,
  arguments: JSON.stringify(args),
});
const result = (toolCalls: ChatToolCall[]): ChatResult => ({
  content: '',
  reasoning: '',
  toolCalls,
  usage: { input: 1, output: 1, cached: 0 },
  model: 'fake',
});

/** 协调者：第 1 步 view_image，第 2 步记下工具结果并结束 */
function viewer(getArgs: () => Record<string, unknown>, seen: string[]): ChatModel {
  return {
    name: 'fake',
    async chat(req) {
      const last = req.messages.at(-1)!;
      if (last.role === 'tool') {
        seen.push(last.content);
        return result([call('no_reply_needed', { reason: 'nothing_to_add' })]);
      }
      if (last.role === 'user' && /trust="principal"/u.test(last.content ?? '')) {
        return result([call('view_image', getArgs())]);
      }
      return result([]);
    },
  };
}

const png = encodePng(new Uint8Array(40 * 30 * 3).fill(200), 40, 30, 3);

async function scenario(env: Record<string, string>, question?: string) {
  const t = await makeApp(env);
  const p = await setupProject(t.app, []);
  const { file } = await writeProjectFile(
    t.app.ctx,
    SYSTEM_ACTOR,
    p.project.id,
    'figs/acc.png',
    png,
    'image/png',
  );
  const seen: string[] = [];
  const runtime = startAgentRuntime(t.app.ctx, {
    model: viewer(() => ({ path_or_id: file.id, ...(question ? { question } : {}) }), seen),
    tickMs: 60_000,
  })!;
  await p.owner.req('POST', `/projects/${p.project.id}/timeline`, { body: '看看这张图' });
  for (let i = 0; i < 4; i++) await runtime.idle();
  await runtime.stop();
  await t.close();
  return seen.map((s) => JSON.parse(s) as Record<string, unknown>);
}

describe('view_image', () => {
  let server: Server | null = null;
  afterEach(() => {
    setOcrEngineForTests(null);
    clearVisionCache();
  });
  afterAll(() => server?.close());

  it('配置了 VISION_MODEL：把图片作为 image_url 发给视觉模型', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 0,
            model: 'fake-vl',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: '一张浅灰色的空白图。' },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    setOcrEngineForTests(async () => {
      throw new Error('不应走 OCR');
    });
    const seen = await scenario(
      {
        LLM_PROVIDERS: JSON.stringify([
          { id: 'vis', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', models: ['fake-vl'] },
        ]),
        VISION_MODEL: 'vis/fake-vl',
      },
      '图里是什么？',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      mode: 'vision',
      description: '一张浅灰色的空白图。',
      width: 40,
      height: 30,
      model: 'vis/fake-vl',
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.model).toBe('fake-vl');
    const content = (bodies[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content;
    expect(JSON.stringify(content[0])).toContain('图里是什么？');
    expect((content[1]!.image_url as { url: string }).url).toMatch(
      /^data:image\/png;base64,iVBOR/u,
    );
  }, 60_000);

  it('没有视觉模型：走 OCR，返回文字 + 尺寸，并说明不是视觉理解', async () => {
    let calls = 0;
    setOcrEngineForTests(async () => {
      calls += 1;
      return { text: 'Accuracy 0.93\nEpoch', confidence: 88, engine: 'tesseract.js' };
    });
    const seen = await scenario({});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      mode: 'ocr',
      ocr_text: 'Accuracy 0.93\nEpoch',
      ocr_confidence: 88,
      width: 40,
      height: 30,
      format: 'png',
    });
    expect(String(seen[0]!.note)).toContain('不是视觉理解');
    expect(calls).toBe(1);
  }, 60_000);
});
