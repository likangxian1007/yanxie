import { describe, expect, it } from 'vitest';
import type { AgentSession, WorkClaim } from '@srh/shared';
import {
  actorLabel,
  collectRefIds,
  describeActivityText,
  guessResourceKind,
  resolveResource,
  type PanelLookup,
} from './panel-labels';

const DOC = 'doc_01M5W2WVKHQDPYT6ZRDMGCBK5V';
const DOC_ARCHIVED = 'doc_01M5W2WVKHQDPYT6ZRDMGCBK5W';
const EXP = 'exp_01M5W2WVKHQDPYT6ZRDMGCBK5V';
const THR = 'thr_01M5W2WVKHQDPYT6ZRDMGCBK5V';

const agents: Partial<AgentSession>[] = [
  { id: 'agt_coord', role: 'coordinator', threadId: null, workingForUserId: null },
  { id: 'agt_thread', role: 'thread', threadId: THR, workingForUserId: 'usr_a' },
  { id: 'agt_personal', role: 'personal', threadId: 'thr_x', workingForUserId: 'usr_a' },
];

const lk: PanelLookup = {
  pid: 'prj_1',
  docTitle: (id) => (id === DOC ? '对比学习研究计划' : undefined),
  experimentTitle: (id) => (id === EXP ? '基线复现' : undefined),
  threadTitle: (id) => (id === THR ? '文献综述' : undefined),
  memberName: (id) => (id === 'usr_a' ? '张三' : undefined),
  memberColor: (id) => (id === 'usr_a' ? 3 : undefined),
  agent: (id) => agents.find((a) => a.id === id) as AgentSession | undefined,
};

describe('resolveResource', () => {
  it('文档章节显示标题与小节，并链接到文档', () => {
    expect(resolveResource('doc_section', `${DOC}#背景`, lk)).toEqual({
      label: '《对比学习研究计划》· 背景',
      href: `/p/prj_1/docs/${DOC}`,
    });
    expect(resolveResource('document', DOC, lk).label).toBe('《对比学习研究计划》');
  });

  it('标题未加载或找不到时显示“文档”', () => {
    expect(resolveResource('doc_section', `${DOC_ARCHIVED}#2 方法`, lk)).toEqual({
      label: '文档 · 2 方法',
      href: `/p/prj_1/docs/${DOC_ARCHIVED}`,
    });
  });

  it('其他类型', () => {
    expect(resolveResource('experiment', EXP, lk)).toEqual({
      label: '实验「基线复现」',
      href: `/p/prj_1/experiments/${EXP}`,
    });
    expect(resolveResource('file', 'data/raw/**', lk)).toEqual({
      label: '文件 data/raw/**',
      href: null,
    });
    expect(resolveResource('topic', 'baseline-复现', lk).label).toBe('议题「baseline-复现」');
    expect(resolveResource('topic', THR, lk).label).toBe('线程「文献综述」');
  });

  it('按前缀猜类型', () => {
    expect(guessResourceKind(`${DOC}#背景`)).toBe('doc_section');
    expect(guessResourceKind(DOC)).toBe('document');
    expect(guessResourceKind(EXP)).toBe('experiment');
    expect(guessResourceKind('data/a.csv')).toBe('file');
  });
});

describe('actorLabel', () => {
  it('agent 显示是谁的 agent', () => {
    const agent = (id: string | null) => ({ kind: 'agent' as const, id, name: '研协' });
    expect(actorLabel(agent('agent:coordinator'), lk)).toMatchObject({
      name: '协调者',
      kind: 'coordinator',
    });
    expect(actorLabel(agent(`agent:${THR}`), lk).name).toBe('文献综述 的 agent');
    expect(actorLabel(agent('agt_coord'), lk).name).toBe('协调者');
    expect(actorLabel(agent('agt_thread'), lk).name).toBe('文献综述 的 agent');
    expect(actorLabel(agent('agt_personal'), lk).name).toBe('张三 的个人 agent');
    expect(actorLabel(agent('agt_unknown'), lk, THR).name).toBe('文献综述 的 agent');
    expect(actorLabel(agent('agt_unknown'), lk).name).toBe('研协');
  });

  it('成员带上头像色', () => {
    expect(actorLabel({ kind: 'user', id: 'usr_a', name: '旧名' }, lk)).toEqual({
      name: '张三',
      kind: 'user',
      color: 3,
    });
  });
});

describe('describeActivityText', () => {
  const claim = {
    resourceKind: 'doc_section',
    resourceRef: `${DOC}#背景：动机`,
  } as WorkClaim;

  it('认领活动里的原始 ref 换成标题，小节里带冒号时按已知认领切分', () => {
    expect(
      describeActivityText(
        { type: 'claim.created', text: `认领了 ${DOC}#背景：动机：改写背景`, href: null },
        [claim],
        lk,
      ),
    ).toEqual({
      label: '认领了 《对比学习研究计划》· 背景：动机：改写背景',
      href: `/p/prj_1/docs/${DOC}`,
    });
  });

  it('没有对应认领时按第一个冒号切分', () => {
    expect(
      describeActivityText(
        { type: 'claim.conflict', text: `与他人的认领重叠：${DOC}`, href: null },
        [],
        lk,
      ).label,
    ).toBe('与他人的认领重叠：《对比学习研究计划》');
  });

  it('其他活动原样返回', () => {
    expect(describeActivityText({ type: 'thread.created', text: 'x', href: '/a' }, [], lk)).toEqual(
      { label: 'x', href: '/a' },
    );
  });

  it('收集需要查标题的 id', () => {
    expect(collectRefIds([`认领了 ${DOC}#背景`, EXP, `${DOC}`])).toEqual({
      docIds: [DOC],
      expIds: [EXP],
    });
  });
});
