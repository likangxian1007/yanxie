import { describe, expect, it } from 'vitest';
import type { WorkClaim } from '@srh/shared';
import { claimTarget } from '@/components/collab/claim-target';
import {
  claimHolderLabel,
  docClaimLabel,
  parseDocClaimRef,
} from '@/features/collab-kit/claim-label';
import { titleFromOutline } from './autoTitle';
import { claimsForDoc, findOutlineIndex, toDocClaimViews } from './claimViews';
import { fadeEdges, fadeMask } from './toolbarFade';

function claim(over: Partial<WorkClaim>): WorkClaim {
  return {
    id: 'clm_1',
    projectId: 'p1',
    threadId: 'thr_1',
    holder: { kind: 'agent', id: 'ses_1', name: '研协' },
    onBehalfOfUserId: 'usr_a',
    resourceKind: 'doc_section',
    resourceRef: 'doc_1#背景',
    mode: 'exclusive',
    intent: '补背景段落',
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: '2026-10-26T00:00:00.000Z',
    ...over,
  };
}

const names = (id: string) => ({ usr_a: '张三', usr_b: '李四' })[id];

describe('认领的可读名字（collab-kit/claim-label）', () => {
  it('解析 doc_xxx#章节 与整篇文档，兼容类型前缀', () => {
    expect(parseDocClaimRef(claim({}))).toEqual({ docId: 'doc_1', section: '背景' });
    expect(parseDocClaimRef(claim({ resourceRef: 'doc:doc_1#2 方法' }))).toEqual({
      docId: 'doc_1',
      section: '2 方法',
    });
    expect(parseDocClaimRef(claim({ resourceKind: 'document', resourceRef: 'doc_1' }))).toEqual({
      docId: 'doc_1',
      section: null,
    });
    expect(parseDocClaimRef(claim({ resourceKind: 'experiment', resourceRef: 'exp_1' }))).toBe(
      null,
    );
  });

  it('显示「《标题》· 章节」，不出现原始 id', () => {
    expect(docClaimLabel({ docId: 'doc_1', section: '背景' }, '对比学习研究计划')).toBe(
      '《对比学习研究计划》· 背景',
    );
    expect(docClaimLabel({ docId: 'doc_1', section: null }, '')).toBe('这篇文档');
  });

  it('agent 认领显示「张三的 agent」，人显示自己的名字', () => {
    expect(claimHolderLabel(claim({}), names)).toBe('张三的 agent');
    expect(claimHolderLabel(claim({ onBehalfOfUserId: null }), names)).toBe('研协');
    expect(
      claimHolderLabel(claim({ holder: { kind: 'user', id: 'usr_b', name: '李四' } }), names),
    ).toBe('李四');
  });
});

describe('文档页认领条（claimViews）', () => {
  const outline = [
    { heading: '对比学习研究计划', level: 1 },
    { heading: '背景', level: 2 },
    { heading: '2 方法', level: 2 },
  ];

  it('只取这篇文档上有效、未过期的认领，agent 排前面', () => {
    const list = [
      claim({ id: 'other', resourceRef: 'doc_2#背景' }),
      claim({ id: 'released', status: 'released' }),
      claim({ id: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
      claim({
        id: 'human',
        holder: { kind: 'user', id: 'usr_b', name: '李四' },
        createdAt: '2026-10-25T00:00:00.000Z',
      }),
      claim({ id: 'agent' }),
      claim({ id: 'whole', resourceKind: 'document', resourceRef: 'doc_1' }),
    ];
    expect(claimsForDoc(list, 'doc_1').map((c) => c.claim.id)).toEqual(['agent', 'whole', 'human']);
  });

  it('交给 ClaimBadge 的副本：「张三的 agent 正在改：文档章节 「背景」」，并能跳到大纲', () => {
    const [v] = toDocClaimViews([claim({})], 'doc_1', '对比学习研究计划', outline, names);
    expect(v!.display.holder.name).toBe('张三的 agent');
    expect(claimTarget(v!.display)).toBe('文档章节 「背景」');
    expect(claimTarget(v!.display)).not.toContain('doc_1');
    expect(v!.outlineIndex).toBe(1);
  });

  it('整篇认领显示文档标题；章节名忽略编号也能对上大纲', () => {
    const views = toDocClaimViews(
      [
        claim({ id: 'w', resourceKind: 'document', resourceRef: 'doc_1' }),
        claim({ id: 's', resourceRef: 'doc_1#方法' }),
      ],
      'doc_1',
      '计划',
      outline,
      names,
    );
    expect(claimTarget(views[0]!.display)).toBe('文档 《计划》');
    expect(views[0]!.outlineIndex).toBe(-1);
    expect(findOutlineIndex(outline, '方法')).toBe(2);
    expect(findOutlineIndex(outline, '不存在')).toBe(-1);
  });
});

describe('工具栏滚动提示', () => {
  it('放得下时不加遮罩；能往右滚时右侧渐隐；滚到中间两侧都渐隐', () => {
    expect(fadeEdges(0, 360, 360)).toEqual({ start: false, end: false });
    expect(fadeEdges(0, 360, 800)).toEqual({ start: false, end: true });
    expect(fadeEdges(100, 360, 800)).toEqual({ start: true, end: true });
    expect(fadeEdges(440, 360, 800)).toEqual({ start: true, end: false });
    expect(fadeMask({ start: false, end: false })).toBe('');
    expect(fadeMask({ start: false, end: true })).toContain('transparent)');
    expect(fadeMask({ start: true, end: false })).toMatch(
      /^linear-gradient\(to right, transparent/u,
    );
  });
});

describe('标题跟随第一个一级标题', () => {
  it('未命名的富文本文档跟随 H1；已有标题、非一级标题、其他类型不动', () => {
    const h1 = [{ heading: ' 对比学习研究计划 ', level: 1 }];
    expect(titleFromOutline({ kind: 'doc', title: '未命名文档' }, h1)).toBe('对比学习研究计划');
    expect(titleFromOutline({ kind: 'doc', title: '' }, h1)).toBe('对比学习研究计划');
    expect(titleFromOutline({ kind: 'doc', title: '我的计划' }, h1)).toBe(null);
    expect(titleFromOutline({ kind: 'latex', title: '未命名文档' }, h1)).toBe(null);
    expect(
      titleFromOutline({ kind: 'doc', title: '未命名文档' }, [{ heading: '背景', level: 2 }]),
    ).toBe(null);
    expect(titleFromOutline({ kind: 'doc', title: '未命名文档' }, [])).toBe(null);
  });
});
