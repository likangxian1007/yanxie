import { describe, it, expect } from 'vitest';
import {
  PaperQaAskInput,
  PaperQaSessionCreateInput,
  PaperQaSessionUpdateInput,
  PaperQaPublishSelection,
  PaperPublishInput,
} from '../src';
describe('持久问答契约', () => {
  it('选句需显式提供文件、有效页码和有限文本，拒绝伪造的额外字段', () => {
    const input = {
      requestId: 'b22c0b97-a459-4cea-bf46-a720ee2c9d45',
      question: '解释原文',
      selection: { fileId: 'fil_one', page: 1, text: 'quoted' },
    };
    expect(PaperQaAskInput.parse(input).selection).toEqual(input.selection);
    for (const selection of [
      { ...input.selection, page: 0 },
      { ...input.selection, text: 'x'.repeat(4001) },
      { ...input.selection, ownerUserId: 'other' },
    ])
      expect(PaperQaAskInput.safeParse({ ...input, selection }).success).toBe(false);
  });
  it('问题默认仅本篇、无历史上下文；请求编号必须是 UUID', () => {
    const input = { question: '如何验证实验', requestId: 'b22c0b97-a459-4cea-bf46-a720ee2c9d45' };
    expect(PaperQaAskInput.parse(input)).toMatchObject({
      searchScope: 'paper',
      contextTurnIds: [],
    });
    for (const patch of [
      { requestId: 'wrong' },
      { question: '' },
      { question: 'x'.repeat(2001) },
      { contextTurnIds: ['a', 'b', 'c', 'd'] },
      { ownerUserId: 'someone' },
    ])
      expect(PaperQaAskInput.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it('会话名称受限，重命名必须携带正整数版本', () => {
    expect(PaperQaSessionCreateInput.safeParse({ title: '实验结论' }).success).toBe(true);
    expect(PaperQaSessionCreateInput.safeParse({ title: ' ' }).success).toBe(false);
    expect(PaperQaSessionUpdateInput.safeParse({ title: '新名称', baseVersion: 0 }).success).toBe(
      false,
    );
  });
  it('发布缺省不携带问答；附带问答的引用策略与预览指纹严格校验', () => {
    const base = {
      projectId: 'p',
      requestId: 'b22c0b97-a459-4cea-bf46-a720ee2c9d45',
      sourceUpdatedAt: '2026-11-01T00:00:00.000Z',
    };
    expect(PaperPublishInput.parse(base).qa).toBeUndefined();
    expect(PaperQaPublishSelection.parse({ id: 't', version: 1 })).toEqual({
      id: 't',
      version: 1,
      unsharedSources: 'mark',
      allowMissingContext: false,
    });
    expect(
      PaperQaPublishSelection.safeParse({ id: 't', version: 1, previewHash: 'not-a-hash' }).success,
    ).toBe(false);
    expect(
      PaperPublishInput.safeParse({
        ...base,
        qa: Array.from({ length: 51 }, () => ({ id: 't', version: 1 })),
      }).success,
    ).toBe(false);
  });
});
