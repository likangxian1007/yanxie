import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldSync } from './field-sync';
import { deepEqual, mergeText } from './merge';

describe('mergeText', () => {
  it('只有一边改了：取改的那边', () => {
    expect(mergeText('a\nb\n', 'a\nB\n', 'a\nb\n')).toEqual({ text: 'a\nB\n', conflicts: 0 });
    expect(mergeText('a\nb\n', 'a\nb\n', 'A\nb\n')).toEqual({ text: 'A\nb\n', conflicts: 0 });
  });

  it('改的是不同的行：两边都保留', () => {
    const r = mergeText('一\n二\n三\n', '一（我）\n二\n三\n', '一\n二\n三（他）\n');
    expect(r).toEqual({ text: '一（我）\n二\n三（他）\n', conflicts: 0 });
  });

  it('两人都在同一句末尾补充：整段拼在一起，不交错', () => {
    const base = '在 miniImageNet 上 5-way 1-shot 精度提升。';
    const mine = `${base}【导师补充：需报告 95% 置信区间】`;
    const theirs = `${base}【成员补充：同时测 5-shot】`;
    const r = mergeText(base, mine, theirs);
    expect(r.text).toBe(`${base}【导师补充：需报告 95% 置信区间】【成员补充：同时测 5-shot】`);
    expect(r.conflicts).toBe(0);
  });

  it('同一行改了同一处：两段都保留并计为冲突', () => {
    const r = mergeText('lr = 0.1\n', 'lr = 0.01\n', 'lr = 0.5\n');
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe('lr = 0.01\nlr = 0.5\n');
  });

  it('同一行不同位置的修改：字符级合并', () => {
    const r = mergeText('用 Conv-4 跑 60k 步', '用 ResNet-12 跑 60k 步', '用 Conv-4 跑 80k 步');
    expect(r).toEqual({ text: '用 ResNet-12 跑 80k 步', conflicts: 0 });
  });

  it('deepEqual 比较数组和对象', () => {
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});

// ---------------------------------------------------------------- FieldSync

interface Doc {
  id: string;
  version: number;
  text: string;
  tags: string[];
}

class Conflict extends Error {
  constructor(readonly current: Doc) {
    super('conflict');
  }
}

/** 一个最小的“服务端”：带版本号，baseVersion 不对就 409 */
function fakeServer(initial: Doc) {
  let row = { ...initial };
  const calls: { patch: Partial<Doc>; baseVersion: number }[] = [];
  return {
    get: () => row,
    calls,
    /** 别人改了一下 */
    remote(patch: Partial<Doc>) {
      row = { ...row, ...patch, version: row.version + 1 };
      return row;
    },
    async patch(patch: Partial<Doc>, baseVersion: number): Promise<Doc> {
      calls.push({ patch, baseVersion });
      await Promise.resolve();
      if (baseVersion !== row.version) throw new Conflict({ ...row });
      row = { ...row, ...patch, version: row.version + 1 };
      return { ...row };
    },
  };
}

function setup(initial: Doc) {
  const server = fakeServer(initial);
  /** 客户端缓存：实时事件会把它推到最新 */
  let cache: Doc = { ...initial };
  const sync = new FieldSync<Doc>({
    delay: 50,
    getServer: () => cache,
    send: (patch, baseVersion) => server.patch(patch, baseVersion),
    conflictCurrent: (err) => (err instanceof Conflict ? err.current : null),
    onServer: (obj, force) => {
      if (force || obj.version >= cache.version) cache = obj;
    },
  });
  return {
    sync,
    server,
    cache: () => cache,
    /** 别人改了服务端，事件推到这个客户端 */
    remoteEdit(patch: Partial<Doc>) {
      cache = { ...server.remote(patch) };
      sync.refresh(cache);
    },
  };
}

const D: Doc = { id: 'd1', version: 3, text: '原文', tags: [] };

describe('FieldSync', () => {
  afterEach(() => vi.useRealTimers());

  it('编辑中别人改了同一字段：实时事件不覆盖草稿，保存时用草稿基线 → 409 → 冲突，输入保留', async () => {
    const t = setup(D);
    t.sync.edit('text', '原文【导师补充】');
    // 别人先保存了（版本 3 → 4），缓存被事件推到 4
    t.remoteEdit({ text: '原文【成员补充】' });
    expect(t.sync.field('text')).toMatchObject({
      value: '原文【导师补充】',
      dirty: true,
      remoteChanged: true,
      conflict: null,
    });
    await t.sync.flush();
    // 发出去的 baseVersion 是草稿开始时的 3，不是缓存里的 4
    expect(t.server.calls[0]).toMatchObject({ baseVersion: 3 });
    expect(t.sync.status).toBe('conflict');
    expect(t.sync.field('text').conflict).toEqual({
      mine: '原文【导师补充】',
      theirs: '原文【成员补充】',
      base: '原文',
    });
    // 服务端没有被覆盖，也没有乱码
    expect(t.server.get().text).toBe('原文【成员补充】');
  });

  it('冲突后「保留我的」：以对方的最新版本为基线覆盖', async () => {
    const t = setup(D);
    t.sync.edit('text', '我的');
    t.remoteEdit({ text: '他的' });
    await t.sync.flush();
    t.sync.keepMine('text');
    await t.sync.flush();
    expect(t.server.get()).toMatchObject({ text: '我的', version: 5 });
    expect(t.sync.field('text').dirty).toBe(false);
    expect(t.sync.status).toBe('saved');
  });

  it('冲突后「用对方的」：草稿收起，显示对方的值，不再发请求', async () => {
    const t = setup(D);
    t.sync.edit('text', '我的');
    t.remoteEdit({ text: '他的' });
    await t.sync.flush();
    t.sync.takeTheirs('text');
    expect(t.sync.field('text')).toMatchObject({ value: '他的', dirty: false, conflict: null });
    const n = t.server.calls.length;
    await t.sync.flush();
    expect(t.server.calls.length).toBe(n);
  });

  it('冲突后「手动合并」：保存合并后的文本', async () => {
    const t = setup(D);
    t.sync.edit('text', '原文A');
    t.remoteEdit({ text: '原文B' });
    await t.sync.flush();
    t.sync.resolveWith('text', '原文AB');
    await t.sync.flush();
    expect(t.server.get().text).toBe('原文AB');
  });

  it('对方改的是别的字段：409 后自动换基线重发，用户无感', async () => {
    const t = setup(D);
    t.sync.edit('text', '我的');
    // 服务端被改了 tags，但事件还没到这个客户端
    t.server.remote({ tags: ['基线'] });
    await t.sync.flush();
    expect(t.server.calls.map((c) => c.baseVersion)).toEqual([3, 4]);
    expect(t.server.get()).toMatchObject({ text: '我的', tags: ['基线'], version: 5 });
    expect(t.sync.status).toBe('saved');
  });

  it('对方改的是别的字段且事件先到：基线版本直接前移，不用 409 往返', async () => {
    const t = setup(D);
    t.sync.edit('text', '我的');
    t.remoteEdit({ tags: ['基线'] });
    expect(t.sync.field('text').remoteChanged).toBe(false);
    await t.sync.flush();
    expect(t.server.calls.map((c) => c.baseVersion)).toEqual([4]);
  });

  it('自己连续保存不算冲突：基线跟着自己的保存结果前移', async () => {
    const t = setup(D);
    t.sync.edit('text', '一');
    await t.sync.flush();
    t.sync.edit('text', '一二');
    await t.sync.flush();
    t.sync.edit('text', '一二三');
    await t.sync.flush();
    expect(t.server.calls.map((c) => c.baseVersion)).toEqual([3, 4, 5]);
    expect(t.server.get().text).toBe('一二三');
  });

  it('保存在途时继续输入：在途结束后接着发，基线是在途那次的结果', async () => {
    const t = setup(D);
    t.sync.edit('text', '一');
    const first = t.sync.flush();
    t.sync.edit('text', '一二', { immediate: true });
    await first;
    await t.sync.flush();
    expect(t.server.get().text).toBe('一二');
    expect(t.server.calls.map((c) => c.baseVersion)).toEqual([3, 4]);
  });

  it('同时保存（两个客户端同一版本）：只有一个成功，另一个进冲突而不是覆盖', async () => {
    const server = fakeServer(D);
    const mk = () => {
      let cache: Doc = { ...D };
      return new FieldSync<Doc>({
        getServer: () => cache,
        send: (p, v) => server.patch(p, v),
        conflictCurrent: (err) => (err instanceof Conflict ? err.current : null),
        onServer: (obj) => {
          cache = obj;
        },
      });
    };
    const a = mk();
    const b = mk();
    a.edit('text', 'A 的版本');
    b.edit('text', 'B 的版本');
    await Promise.all([a.flush(), b.flush()]);
    expect(server.get().text).toBe('A 的版本');
    expect(a.status).toBe('saved');
    expect(b.status).toBe('conflict');
    expect(b.field('text').conflict).toMatchObject({ mine: 'B 的版本', theirs: 'A 的版本' });
  });

  it('对方改成了和我一样：视为已保存', async () => {
    const t = setup(D);
    t.sync.edit('text', '一样');
    t.server.remote({ text: '一样' });
    await t.sync.flush();
    expect(t.sync.field('text').dirty).toBe(false);
    expect(t.sync.status).not.toBe('conflict');
  });

  it('网络错误：改动保留，状态 error，可以重试', async () => {
    let fail = true;
    let cache: Doc = { ...D };
    const sync = new FieldSync<Doc>({
      getServer: () => cache,
      send: async (p, v) => {
        if (fail) throw new Error('offline');
        cache = { ...cache, ...p, version: v + 1 };
        return cache;
      },
      conflictCurrent: () => null,
      onServer: (obj) => {
        cache = obj;
      },
    });
    sync.edit('text', '离线写的');
    await sync.flush();
    expect(sync.status).toBe('error');
    expect(sync.field('text').value).toBe('离线写的');
    fail = false;
    await sync.flush();
    expect(cache.text).toBe('离线写的');
    expect(sync.hasUnsaved()).toBe(false);
  });

  it('防抖：停止输入一段时间后自动保存', async () => {
    vi.useFakeTimers();
    const t = setup(D);
    t.sync.edit('text', '一');
    t.sync.edit('text', '一二');
    expect(t.server.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(t.server.calls).toHaveLength(1);
    expect(t.server.calls[0]?.patch).toEqual({ text: '一二' });
  });
});
