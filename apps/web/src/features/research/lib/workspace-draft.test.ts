import { describe, expect, it } from 'vitest';
import type { ResearchItem } from '@srh/shared';
import { draftKey, itemDraft, itemDraftText, restoreItemDraft } from './workspace-draft';

const item = (version: number, body: string): ResearchItem => ({
  id: 'rwi_1',
  projectId: 'p1',
  recordId: 'r1',
  kind: 'note',
  title: '笔记',
  body,
  resource: null,
  evidenceRef: null,
  action: null,
  origin: null,
  parentId: null,
  position: { x: 0, y: 0 },
  version,
  positionVersion: 1,
  createdBy: { kind: 'user', id: 'u1', name: '甲' },
  updatedBy: { kind: 'user', id: 'u1', name: '甲' },
  createdAt: '',
  updatedAt: '',
  archivedAt: null,
});

describe('工作区本机草稿', () => {
  it('不同账号、项目、记录和内容使用独立键', () => {
    const keys = [
      draftKey('u1', 'p1', 'r1', 'i1'),
      draftKey('u2', 'p1', 'r1', 'i1'),
      draftKey('u1', 'p2', 'r1', 'i1'),
      draftKey('u1', 'p1', 'r2', 'i1'),
      draftKey('u1', 'p1', 'r1', 'i2'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('并发更新时保留本地草稿并提供服务器版本供比较', () => {
    const base = item(1, '原文');
    const remote = item(2, '他人修改');
    const restored = restoreItemDraft(remote, {
      base,
      draft: { ...itemDraft(base), body: '我的草稿' },
      dirty: true,
    });
    expect(restored.draft.body).toBe('我的草稿');
    expect(restored.conflict?.body).toBe('他人修改');
    expect(restored.base.version).toBe(1);
  });
  it('没有本地改动时采用最新服务器版本', () => {
    const base = item(1, '原文');
    const remote = item(2, '新版');
    const restored = restoreItemDraft(remote, { base, draft: itemDraft(base), dirty: false });
    expect(restored.draft.body).toBe('新版');
    expect(restored.conflict).toBeNull();
  });
  it('保留结构化内容的本机修改，不被远端版本覆盖', () => {
    const base: ResearchItem = {
      ...item(1, ''),
      kind: 'draft',
      payload: { kind: 'draft', blocks: [{ id: 'b1', kind: 'text', text: '旧内容' }] },
    };
    const draft = itemDraft(base);
    if (draft.payload?.kind !== 'draft') throw new Error('缺少草稿');
    draft.payload.blocks[0] = { id: 'b1', kind: 'text', text: '本机修改' };
    const restored = restoreItemDraft({ ...base, version: 2 }, { base, draft, dirty: true });
    expect(restored.draft.payload).toEqual({
      kind: 'draft',
      blocks: [{ id: 'b1', kind: 'text', text: '本机修改' }],
    });
    expect(itemDraftText(restored.draft)).toContain('本机修改');
    expect(itemDraftText(itemDraft(restored.conflict!))).toContain('旧内容');
    expect(restored.conflict?.version).toBe(2);
    expect(base.payload).toEqual({
      kind: 'draft',
      blocks: [{ id: 'b1', kind: 'text', text: '旧内容' }],
    });
  });
});
