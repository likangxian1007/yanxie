import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@srh/shared';
import { papers, paperChunks } from '../../src/db/schema';
import { retrieveForQuestion, qaUserPrompt } from '../../src/modules/library/qa';
import { setLibraryLlmForTest } from '../../src/modules/library/llm';
import { invalidateIndex } from '../../src/modules/library/search';
import type { LlmClient } from '../../src/agents/llm/client';
import { makeApp, signup, type TestApp } from '../helpers';

let t: TestApp;
let scope: { kind: 'personal'; ownerUserId: string };
let paperId: string;
const longIntro =
  'The agent adapts its methods when the environment changes. '.repeat(40) +
  'The central contribution is a framework that separates the timing and mechanism of adaptation.';
beforeAll(async () => {
  t = await makeApp();
  const owner = await signup(t.app);
  scope = { kind: 'personal', ownerUserId: owner.user.id };
  paperId = `ppr_${ulid()}`;
  await t.db.db.insert(papers).values({
    id: paperId,
    ownerUserId: owner.user.id,
    title: 'Agent adaptation',
    citekey: 'adaptation',
    source: 'upload',
    status: 'ready',
    parser: 'pdf-text',
    createdBy: { kind: 'user', id: owner.user.id, name: owner.user.name },
  });
  const chunks = [
    [
      'Abstract',
      1,
      'The study investigates how agents learn from feedback and adapt to new tasks.',
    ],
    ['1 Introduction', 2, longIntro],
    [
      '1 Introduction',
      2,
      '• We present a framework that distinguishes different mechanisms of agent adaptation.',
    ],
    ['1 Introduction', 3, 'Published in Transactions on Machine Learning Research (01/2026)'],
    ['1 Introduction', 3, 'Model-Agent Co-Evolution Where to Evolve'],
    [
      '1 Introduction',
      3,
      'We evaluate the framework in diverse environments and discuss the limitations of the evidence.',
    ],
    ['1 Introduction', 4, 'Published in Transactions on Machine Learning Research (01/2026)'],
    ['1 Introduction', 4, 'Imitation & Reward-based Models Tools Model'],
    ['1 Introduction', 5, 'Published in Transactions on Machine Learning Research (01/2026)'],
    [
      '2 Methods',
      5,
      'The experiment uses randomized controlled trials with independent groups and repeated measurements.',
    ],
    [
      '2 Methods › 2.1 Data',
      6,
      'The data include carefully verified observations from three independent experimental settings.',
    ],
    [
      '9 Conclusion',
      53,
      'The final conclusion concerns long-term transfer and requires additional validation.',
    ],
  ] as const;
  await t.db.db.insert(paperChunks).values(
    chunks.map(([sectionPath, page, text], seq) => ({
      id: `${paperId}:${seq}`,
      paperId,
      seq,
      kind: seq === 0 ? ('abstract' as const) : ('paragraph' as const),
      sectionPath,
      page,
      para: seq + 1,
      text,
      boxes: [],
    })),
  );
  invalidateIndex(t.app.ctx, scope);
  setLibraryLlmForTest(t.app.ctx, {
    model: 'mock',
    reasoningModel: 'mock',
    client: {
      chat: {
        completions: {
          async create() {
            return {
              choices: [{ message: { content: 'introduction, background, contributions' } }],
            };
          },
        },
      },
    },
  } as unknown as LlmClient);
}, 60000);
afterAll(async () => {
  await t?.close();
});

describe('章节概括选择真实正文', () => {
  it.each(['概括第一部分introduction', '总结引言', 'Summarize the Introduction', '概括第1节'])(
    '%s：只提供引言正文，页眉和图中文字不能占据来源',
    async (question) => {
      const r = await retrieveForQuestion(t.app.ctx, scope, { question, paperId });
      expect(r.sources.map((s) => s.seq)).toEqual([1, 2, 5]);
      const prompt = qaUserPrompt(question, r.sources, true, []);
      expect(prompt).toContain('central contribution is a framework');
      expect(prompt).not.toContain('Published in');
      expect(prompt).not.toContain('final conclusion');
    },
  );
  it('读取指定章及其子节', async () => {
    const r = await retrieveForQuestion(t.app.ctx, scope, {
      question: '概括第二章 Methods',
      paperId,
    });
    expect(r.sources.map((s) => s.seq)).toEqual([9, 10]);
  });
  it('明确携带引言问题后，“再详细一点”仍使用引言正文', async () => {
    const r = await retrieveForQuestion(t.app.ctx, scope, {
      question: '再详细一点',
      paperId,
      history: [
        { role: 'user', content: '总结引言' },
        { role: 'assistant', content: '先前的回答只帮助理解对话。' },
      ],
    });
    expect(r.sources.map((s) => s.seq)).toEqual([1, 2, 5]);
  });
  it('只读取指定小节，保留该段落的原始引用身份', async () => {
    const r = await retrieveForQuestion(t.app.ctx, scope, {
      question: '总结 section 2.1',
      paperId,
    });
    expect(r.sources.map((s) => s.seq)).toEqual([10]);
    expect(r.sources[0]).toMatchObject({ chunkId: `${paperId}:10`, page: 6, para: 11 });
  });
  it('全篇概括优先正文，既保留摘要和结尾，也排除重复页眉及图片标签', async () => {
    const r = await retrieveForQuestion(t.app.ctx, scope, { question: '概括文献', paperId });
    expect(r.sources.some((s) => s.seq === 0)).toBe(true);
    expect(r.sources.some((s) => s.seq === 11)).toBe(true);
    expect(
      r.sources.some((s) =>
        /Published in|Model-Agent Co-Evolution|Imitation & Reward/u.test(s.text),
      ),
    ).toBe(false);
  });
});
