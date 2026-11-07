import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config';
import {
  createRestorer,
  decide,
  hybridStatus,
  redact,
  resetHybridForTest,
  restore,
  stripThink,
  tryLocal,
} from '../src/agents/llm/hybrid';

/** 假的本机推理服务（OpenAI 兼容）：/models 探活、/chat/completions 回固定内容 */
let server: Server;
let base = '';
let up = true;
const reply = '<think>\n\n</think>\n\n本地摘要';
const defaultEntityJson = '[{"kind":"person","text":"张伟"}]';
let entityJson = defaultEntityJson;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (!up) {
      res.statusCode = 503;
      res.end();
      return;
    }
    if (req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-4b', object: 'model' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const isEntity = body.includes('隐私审查器');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'qwen3-4b',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: isEntity ? entityJson : reply },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  up = true;
  entityJson = defaultEntityJson;
  resetHybridForTest();
});

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    LOCAL_LLM_BASE_URL: base,
    LOCAL_LLM_API_KEY: '',
    LOCAL_LLM_MODEL: 'qwen3-4b',
    LOCAL_LLM_DEVICE: 'Intel Arc GPU',
    LOCAL_LLM_MAX_INPUT_CHARS: 1000,
    HYBRID_ROUTES: '',
    HYBRID_REDACT: true,
    LLM_MODEL: 'deepseek-chat',
    llmConfigured: true,
    ...over,
  } as AppConfig;
}

describe('混合 AI 分流', () => {
  it('没配本地模型时一切走云端', async () => {
    const d = await decide(cfg({ LOCAL_LLM_BASE_URL: '' }), 'doc-rewrite', 10);
    expect(d).toMatchObject({ target: 'cloud', fallback: false });
  });

  it('本地可用时 auto 任务走本地，cloud 任务走云端', async () => {
    expect((await decide(cfg(), 'doc-rewrite', 10)).target).toBe('local');
    expect((await decide(cfg(), 'report', 10)).target).toBe('cloud');
  });

  it('输入超长或本地不可用就回退云端', async () => {
    expect(await decide(cfg(), 'doc-rewrite', 5000)).toMatchObject({
      target: 'cloud',
      fallback: true,
    });
    up = false;
    resetHybridForTest(); // 探活结果有缓存，模拟缓存过期
    expect(await decide(cfg(), 'doc-rewrite', 10)).toMatchObject({
      target: 'cloud',
      fallback: true,
    });
  });

  it('仅本地：本地不可用时报错，绝不发往云端', async () => {
    up = false;
    await expect(decide(cfg(), 'doc-rewrite', 10, 'local_only')).rejects.toThrow(
      /本地模型现在不可用/,
    );
    await expect(
      decide(cfg({ LOCAL_LLM_BASE_URL: '' }), 'doc-rewrite', 10, 'local_only'),
    ).rejects.toThrow(/没有配置本地模型/);
  });

  it('HYBRID_ROUTES 可以改规则，不认识的项忽略', async () => {
    const c = cfg({ HYBRID_ROUTES: '{"report":"auto","doc-rewrite":"cloud","bogus":"local"}' });
    expect((await decide(c, 'report', 10)).target).toBe('local');
    expect((await decide(c, 'doc-rewrite', 10)).target).toBe('cloud');
  });

  it('tryLocal 去掉思考段并记入统计；失败返回 null 让调用方走云端', async () => {
    expect(await tryLocal(cfg(), 'compact', 's', 'u')).toBe('本地摘要');
    const st = await hybridStatus(cfg());
    expect(st.totals.localCalls).toBe(1);
    expect(st.local.up).toBe(true);
    resetHybridForTest();
    up = false;
    expect(await tryLocal(cfg(), 'compact', 's', 'u')).toBeNull();
  });
});

describe('隐私护栏', () => {
  it('规则脱敏数值、邮箱、电话、编号，模型识别人名，还原后与原文一致', async () => {
    const text =
      '张伟在样本 S-2031 上测得准确率 93.7%，浓度 0.25 mM；联系 zhangwei@lab.cn 或 13812345678。';
    const r = await redact(cfg(), [text]);
    const out = r.texts[0]!;
    for (const s of ['张伟', 'S-2031', '93.7%', '0.25 mM', 'zhangwei@lab.cn', '13812345678'])
      expect(out).not.toContain(s);
    expect(out).toContain('〔人名1〕');
    expect(restore(out, r.items)).toBe(text);
  });

  const emailText = '张伟在样本 S-2031 上测得准确率 93.7%，联系 zhangwei@lab.cn';
  for (const [name, json] of [
    ['模型把邮箱域名认成机构', '[{"kind":"person","text":"张伟"},{"kind":"org","text":"lab.cn"}]'],
    [
      '模型把邮箱用户名认成人名',
      '[{"kind":"person","text":"张伟"},{"kind":"person","text":"zhangwei"}]',
    ],
  ] as const) {
    it(`${name}时，邮箱仍整体脱敏，不泄露任何片段`, async () => {
      entityJson = json;
      const r = await redact(cfg(), [emailText]);
      const out = r.texts[0]!;
      expect(out).toContain('〔邮箱1〕');
      for (const s of ['zhangwei', 'lab.cn', '@', '〔机构']) expect(out).not.toContain(s);
      expect(out).toBe('〔人名1〕在样本 〔编号1〕 上测得准确率 〔数值1〕，联系 〔邮箱1〕');
      expect(restore(out, r.items)).toBe(emailText);
    });
  }

  it('同一原文用同一个占位符，年份等整数不动', async () => {
    const r = await redact(cfg({ LOCAL_LLM_BASE_URL: '' }), ['2025 年 0.5 和 0.5'], {
      useLocalModel: false,
    });
    expect(r.texts[0]).toBe('2025 年 〔数值1〕 和 〔数值1〕');
  });

  it('流式还原能处理被切开的占位符', () => {
    const items = [{ placeholder: '〔数值1〕', original: '93.7%', kind: 'number' }];
    const rs = createRestorer(items);
    const out = ['准确率为〔数', '值1〕，较基线'].map((c) => rs.push(c)).join('') + rs.flush();
    expect(out).toBe('准确率为93.7%，较基线');
  });

  it('stripThink 去掉 think 段', () => {
    expect(stripThink('<think>想一想</think>\n答案')).toBe('答案');
  });
});
