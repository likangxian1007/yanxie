import { describe, expect, it } from 'vitest';
import {
  ResearchItemCreateInput,
  ResearchItemUpdateInput,
  ResearchWorkspaceCreateInput,
  ResearchItemPositionInput,
} from '../src';

describe('研究工作区契约', () => {
  it('可从空输入开始研究，条目保留稀疏编辑', () => {
    expect(ResearchWorkspaceCreateInput.parse({})).toMatchObject({
      title: '未命名研究',
      question: '',
    });
    expect(ResearchItemCreateInput.parse({ kind: 'note', title: '想法' })).toMatchObject({
      body: '',
      resource: null,
      position: { x: 0, y: 0 },
    });
    expect(ResearchItemUpdateInput.parse({ baseVersion: 1, body: '修改' })).toEqual({
      baseVersion: 1,
      body: '修改',
    });
    expect(
      ResearchItemPositionInput.safeParse({
        basePositionVersion: 1,
        position: { x: Infinity, y: 0 },
      }).success,
    ).toBe(false);
  });
});
