import { useState, type ReactNode } from 'react';
import { configure, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { COORDINATOR_ASSIGNEE, type ProjectMember, type Thread } from '@srh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qk } from '@/lib/query-keys';
import {
  ACTIVE_PROJECT_THREADS,
  AssigneePicker,
  buildAssigneeOptions,
  describeAssignee,
  filterAssigneeOptions,
  toggleAssignee,
} from './assignees';

// 完整 pnpm check 下机器负载高，放宽超时避免偶发失败
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const PID = 'prj_1';

function member(id: string, name: string, role: ProjectMember['role'] = 'member'): ProjectMember {
  return {
    projectId: PID,
    user: { id, name, email: `${id}@lab.edu`, avatarColor: 2, avatarUrl: null },
    role,
    joinedAt: '2026-10-01T00:00:00.000Z',
  };
}

function thread(id: string, title: string, extra: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: PID,
    kind: 'project',
    rootMessageId: `msg_${id}`,
    title,
    label: null,
    ownerUserId: null,
    statusBucket: 'working',
    statusText: '',
    resolved: false,
    replyCount: 0,
    forwardedAt: null,
    agentSessionId: null,
    lastActivityAt: '2026-10-20T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

const MEMBERS = [member('usr_b', '李四'), member('usr_a', '张三', 'owner')];
const THREADS = [
  thread('thr_old', '复现 baseline', { lastActivityAt: '2026-10-10T00:00:00.000Z' }),
  thread('thr_new', '调研扩散模型', { lastActivityAt: '2026-10-25T00:00:00.000Z' }),
  thread('thr_done', '已结束的线程', { resolved: true }),
  thread('thr_me', '个人线程', { kind: 'personal' }),
];

describe('buildAssigneeOptions', () => {
  it('成员（自己在前）→ 协调者 → 进行中的项目线程 agent（最近活跃在前）', () => {
    const options = buildAssigneeOptions(MEMBERS, THREADS, 'usr_b');
    expect(options.map((o) => o.value)).toEqual([
      'usr_b',
      'usr_a',
      COORDINATOR_ASSIGNEE,
      'agent:thr_new',
      'agent:thr_old',
    ]);
    expect(options[0]).toMatchObject({ kind: 'user', label: '李四', sublabel: '你', color: 2 });
    expect(options[1]).toMatchObject({ sublabel: '负责人' });
    expect(options[3]).toMatchObject({ kind: 'agent', label: '调研扩散模型' });
  });

  it('没有成员和线程时仍然有协调者', () => {
    expect(buildAssigneeOptions([], []).map((o) => o.value)).toEqual([COORDINATOR_ASSIGNEE]);
  });

  it('describeAssignee 兜底：已结束线程的 agent / 未知成员', () => {
    const byValue = new Map(buildAssigneeOptions(MEMBERS, THREADS).map((o) => [o.value, o]));
    expect(describeAssignee('usr_a', byValue)?.label).toBe('张三');
    expect(describeAssignee('agent:thr_done', byValue)).toMatchObject({
      kind: 'agent',
      sublabel: '线程已结束',
    });
    expect(describeAssignee('usr_gone', byValue)).toBeNull();
  });

  it('搜索与多选切换', () => {
    const options = buildAssigneeOptions(MEMBERS, THREADS);
    expect(filterAssigneeOptions(options, '张').map((o) => o.value)).toEqual(['usr_a']);
    expect(filterAssigneeOptions(options, 'agent').every((o) => o.kind === 'agent')).toBe(true);
    expect(filterAssigneeOptions(options, '  ')).toHaveLength(options.length);
    expect(toggleAssignee(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleAssignee(['a', 'b'], 'a')).toEqual(['b']);
  });
});

function renderWithData(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(qk.members(PID), MEMBERS);
  qc.setQueryData(qk.threads(PID, ACTIVE_PROJECT_THREADS), THREADS);
  qc.setQueryData(qk.me, {
    user: { id: 'usr_a', name: '张三', email: 'a@lab.edu', avatarColor: 1, avatarUrl: null },
    projects: [],
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function MultiHarness({ onChange }: { onChange: (v: string[]) => void }) {
  const [value, setValue] = useState<string[]>([]);
  return (
    <AssigneePicker
      multiple
      projectId={PID}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('AssigneePicker', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('分组渲染成员与 agent，并提示指派给 agent 会唤醒它', async () => {
    renderWithData(<AssigneePicker projectId={PID} value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '指派' }));
    const dialog = await screen.findByRole('dialog', { name: '选择指派对象' });
    expect(within(dialog).getByRole('group', { name: '成员' })).toBeInTheDocument();
    const agents = within(dialog).getByRole('group', { name: 'AI agent' });
    expect(within(agents).getByText('指派给 agent 会唤醒它开始做')).toBeInTheDocument();
    expect(
      within(agents)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringContaining('协调者'),
      expect.stringContaining('调研扩散模型'),
      expect.stringContaining('复现 baseline'),
    ]);
  });

  it('单选：点击选项后回调并关闭', async () => {
    const onChange = vi.fn();
    renderWithData(<AssigneePicker projectId={PID} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '指派' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('option', { name: /李四/u }));
    expect(onChange).toHaveBeenCalledWith('usr_b');
  });

  it('多选：搜索 + 键盘上下选择、回车切换，选中项打勾', async () => {
    const onChange = vi.fn();
    renderWithData(<MultiHarness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '指派' }));
    const dialog = await screen.findByRole('dialog');
    const search = within(dialog).getByRole('combobox', { name: '搜索指派对象' });

    fireEvent.change(search, { target: { value: '线程' } });
    // 只剩两个线程 agent；向下一格后回车 → 选第二个
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['agent:thr_old']);
    expect(within(dialog).getByRole('option', { name: /复现 baseline/u })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('option', { name: /张三/u }));
    expect(onChange).toHaveBeenLastCalledWith(['agent:thr_old', 'usr_a']);
    // 多选不关闭
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
