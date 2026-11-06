import { describe, expect, it } from 'vitest';
import type { AgentProfile, ModelCatalog, Skill, SlashCommand } from '@srh/shared';
import {
  effectiveEffort,
  effortForModelChange,
  findModel,
  matchEffort,
  matchModel,
  modelLabel,
  sessionModel,
  sessionView,
} from './model-utils';
import {
  buildSlashItems,
  filterSlashItems,
  parseSlashLine,
  pickBehavior,
  resolveSlash,
  slashQuery,
  type SlashContext,
} from './slash';

const cmd = (name: string, kind: SlashCommand['kind'], extra: Partial<SlashCommand> = {}) =>
  ({
    id: `builtin:${name}`,
    projectId: null,
    scope: 'builtin',
    ownerUserId: null,
    name,
    description: `${name} 的说明`,
    argumentHint: '',
    kind,
    template: '',
    updatedAt: null,
    ...extra,
  }) satisfies SlashCommand;

const skill = (slug: string, extra: Partial<Skill> = {}) =>
  ({
    id: `skl_${slug}`,
    projectId: 'prj_1',
    scope: 'project',
    ownerUserId: null,
    slug,
    name: slug,
    description: `${slug} 技能`,
    body: '',
    attachments: [],
    enabled: true,
    userInvocable: true,
    modelInvocable: true,
    updatedBy: null,
    updatedAt: null,
    ...extra,
  }) satisfies Skill;

const COMMANDS: SlashCommand[] = [
  cmd('help', 'client'),
  cmd('model', 'client'),
  cmd('effort', 'client'),
  cmd('profile', 'client'),
  cmd('skill', 'prompt'),
  cmd('clear', 'session'),
  cmd('compact', 'session'),
  cmd('forward', 'client'),
  cmd('goal', 'prompt', { argumentHint: '<目标>' }),
  cmd('plan', 'prompt'),
  cmd('stop', 'client'),
  cmd('weekly', 'prompt', { id: 'cmd_1', scope: 'project', description: '整理本周进展' }),
];
const SKILLS: Skill[] = [
  skill('lit-review', { name: '文献综述' }),
  skill('hidden', { userInvocable: false }),
  skill('off', { enabled: false }),
  skill('plan'), // 与内置指令同名：指令优先
];

const SESSION: SlashContext = { hasSession: true, personal: false };
const PERSONAL: SlashContext = { hasSession: true, personal: true };
const NO_SESSION: SlashContext = { hasSession: false, personal: true };

describe('buildSlashItems', () => {
  it('内置 → skill → 自定义，过滤掉不可点名、停用和同名的 skill', () => {
    const items = buildSlashItems({ commands: COMMANDS, skills: SKILLS }, PERSONAL);
    expect(items.map((i) => `${i.group}:${i.name}`)).toEqual([
      'builtin:help',
      'builtin:model',
      'builtin:effort',
      'builtin:profile',
      'builtin:skill',
      'builtin:clear',
      'builtin:compact',
      'builtin:forward',
      'builtin:goal',
      'builtin:plan',
      'builtin:stop',
      'skill:lit-review',
      'custom:weekly',
    ]);
    expect(items.find((i) => i.name === 'lit-review')?.label).toBe('文献综述');
  });

  it('项目线程里没有 /forward；还没有会话时只剩 help 和 prompt 类', () => {
    const inThread = buildSlashItems({ commands: COMMANDS, skills: [] }, SESSION);
    expect(inThread.some((i) => i.name === 'forward')).toBe(false);
    expect(inThread.some((i) => i.name === 'stop')).toBe(true);

    const hero = buildSlashItems({ commands: COMMANDS, skills: [] }, NO_SESSION).map((i) => i.name);
    expect(hero).toEqual(['help', 'skill', 'goal', 'plan', 'weekly']);
  });
});

describe('slashQuery', () => {
  it('只在行首斜杠、还没敲空格时返回查询', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/mo')).toBe('mo');
    expect(slashQuery('/goal ')).toBeNull();
    expect(slashQuery('/goal 写完')).toBeNull();
    expect(slashQuery(' /mo')).toBeNull();
    expect(slashQuery('hello /mo')).toBeNull();
    expect(slashQuery('/a\nb')).toBeNull();
  });
});

describe('filterSlashItems', () => {
  const items = buildSlashItems({ commands: COMMANDS, skills: SKILLS }, PERSONAL);
  const names = (q: string) => filterSlashItems(items, q).map((i) => i.name);

  it('空查询原样返回', () => {
    expect(names('')).toEqual(items.map((i) => i.name));
  });

  it('前缀优先，其次包含、子序列', () => {
    expect(names('c')[0]).toBe('clear');
    expect(names('c').slice(0, 2)).toEqual(['clear', 'compact']);
    // compact 包含 pa；plan 只是子序列，排在后面
    expect(names('pa')).toEqual(['compact', 'plan']);
    expect(names('lrv')).toEqual(['lit-review']);
  });

  it('能按显示名和描述搜到', () => {
    expect(names('文献')).toEqual(['lit-review']);
    expect(names('本周')).toEqual(['weekly']);
  });

  it('大小写不敏感，匹配不到返回空', () => {
    expect(names('MOD')).toEqual(['model']);
    expect(names('zzz')).toEqual([]);
  });
});

describe('parseSlashLine', () => {
  it('解析名字和参数', () => {
    expect(parseSlashLine('/goal 写完第三章')).toEqual({ name: 'goal', args: '写完第三章' });
    expect(parseSlashLine('/clear')).toEqual({ name: 'clear', args: '' });
    expect(parseSlashLine('/Model  ds/v4 ')).toEqual({ name: 'model', args: 'ds/v4' });
    expect(parseSlashLine('/plan 第一行\n第二行')).toEqual({
      name: 'plan',
      args: '第一行\n第二行',
    });
  });

  it('路径、分数和普通文字不算指令', () => {
    expect(parseSlashLine('/usr/bin 很慢')).toBeNull();
    expect(parseSlashLine('5/8 的人同意')).toBeNull();
    expect(parseSlashLine('/')).toBeNull();
    expect(parseSlashLine('hello')).toBeNull();
  });
});

describe('resolveSlash', () => {
  const items = buildSlashItems({ commands: COMMANDS, skills: SKILLS }, PERSONAL);
  it('按种类分派', () => {
    expect(resolveSlash('/model ds/v4', items, PERSONAL)).toEqual({
      type: 'client',
      name: 'model',
      args: 'ds/v4',
    });
    expect(resolveSlash('/clear', items, PERSONAL)).toEqual({
      type: 'session',
      name: 'clear',
      args: '',
    });
    expect(resolveSlash('/goal clear', items, PERSONAL)).toEqual({
      type: 'session',
      name: 'goal',
      args: 'clear',
    });
    expect(resolveSlash('/goal 跑完消融', items, PERSONAL)).toEqual({ type: 'send' });
    expect(resolveSlash('/lit-review 扩散模型', items, PERSONAL)).toEqual({ type: 'send' });
    expect(resolveSlash('/weekly', items, PERSONAL)).toEqual({ type: 'send' });
  });

  it('未知指令当普通文字发；当前不能用的内置指令给出 unavailable', () => {
    expect(resolveSlash('/xyz 你好', items, PERSONAL)).toEqual({ type: 'send' });
    expect(resolveSlash('普通消息', items, PERSONAL)).toEqual({ type: 'send' });
    const threadItems = buildSlashItems({ commands: COMMANDS, skills: [] }, SESSION);
    expect(resolveSlash('/forward', threadItems, SESSION)).toEqual({
      type: 'unavailable',
      name: 'forward',
    });
    const heroItems = buildSlashItems({ commands: COMMANDS, skills: [] }, NO_SESSION);
    expect(resolveSlash('/goal clear', heroItems, NO_SESSION).type).toBe('unavailable');
  });

  it('选中 prompt 类插入文本，其余直接执行', () => {
    const goal = items.find((i) => i.name === 'goal');
    const clear = items.find((i) => i.name === 'clear');
    const model = items.find((i) => i.name === 'model');
    expect(goal && pickBehavior(goal)).toBe('insert');
    expect(clear && pickBehavior(clear)).toBe('execute');
    expect(model && pickBehavior(model)).toBe('execute');
  });
});

describe('model-utils', () => {
  const catalog: ModelCatalog = {
    defaultModel: 'deepseek/deepseek-v4-pro',
    defaultEffort: 'high',
    providers: [
      {
        id: 'deepseek',
        projectId: null,
        source: 'env',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        thinkingFormat: 'deepseek',
        hasApiKey: true,
        enabled: true,
        createdAt: null,
        models: [
          {
            id: 'deepseek/deepseek-v4-pro',
            providerId: 'deepseek',
            model: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            description: null,
            efforts: ['off', 'low', 'high', 'max'],
            defaultEffort: 'high',
          },
          {
            id: 'deepseek/deepseek-chat',
            providerId: 'deepseek',
            model: 'deepseek-chat',
            name: 'DeepSeek Chat',
            description: null,
            efforts: ['off'],
            defaultEffort: 'off',
          },
        ],
      },
    ],
  };

  it('老会话的裸模型名也能找到，找不到时回到默认模型', () => {
    expect(findModel(catalog, 'deepseek-chat')?.id).toBe('deepseek/deepseek-chat');
    expect(sessionModel(catalog, 'gpt-legacy')?.id).toBe('deepseek/deepseek-v4-pro');
  });

  it('强度：模型不支持就用模型默认', () => {
    const pro = findModel(catalog, 'deepseek/deepseek-v4-pro');
    expect(effectiveEffort(pro, 'max')).toBe('max');
    expect(effectiveEffort(pro, 'medium')).toBe('high');
    expect(effectiveEffort(pro, null)).toBe('high');
    expect(modelLabel(pro, 'high')).toBe('DeepSeek V4 Pro · 高');
    const chat = findModel(catalog, 'deepseek/deepseek-chat');
    expect(modelLabel(chat, 'off')).toBe('DeepSeek Chat');
    expect(chat && effortForModelChange(chat, 'high')).toBeNull();
    expect(pro && effortForModelChange(pro, 'low')).toBeUndefined();
  });

  it('强度预览遵循显式值、角色建议、项目默认的顺序，并按模型兼容回退', () => {
    const profile: AgentProfile = {
      id: 'role',
      projectId: null,
      scope: 'builtin',
      ownerUserId: null,
      slug: 'review',
      name: '审阅',
      description: '',
      icon: 'book',
      prompt: '',
      skills: [],
      starters: [],
      effort: 'max',
      updatedAt: null,
    };
    const session = { model: catalog.defaultModel, effort: null, profile: 'review' };
    expect(sessionView(catalog, [profile], session).effort).toBe('max');
    expect(sessionView(catalog, [profile], { ...session, effort: 'low' }).effort).toBe('low');
    expect(
      sessionView({ ...catalog, defaultEffort: 'low' }, [], { ...session, profile: null }).effort,
    ).toBe('low');
    const model = findModel(catalog, catalog.defaultModel)!;
    expect(
      effectiveEffort({ ...model, efforts: ['low', 'high'], defaultEffort: 'low' }, 'max'),
    ).toBe('high');
  });

  it('指令参数匹配', () => {
    expect(matchModel(catalog, 'deepseek-chat')?.id).toBe('deepseek/deepseek-chat');
    expect(matchModel(catalog, 'v4')?.id).toBe('deepseek/deepseek-v4-pro');
    expect(matchModel(catalog, 'deepseek')).toBeNull();
    expect(matchEffort('HIGH')).toBe('high');
    expect(matchEffort('最高')).toBe('max');
    expect(matchEffort('超级')).toBeNull();
  });
});
