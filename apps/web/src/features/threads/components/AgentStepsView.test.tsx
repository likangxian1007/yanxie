import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { AgentStep } from '@srh/shared';
import { AgentStepsView } from './AgentStepsView';

let n = 0;
const step = (kind: AgentStep['kind'], over: Partial<AgentStep> = {}): AgentStep => {
  n += 1;
  return {
    id: `st_${n}`,
    sessionId: 'agt_1',
    turnId: 't1',
    index: n,
    kind,
    name: null,
    content: '',
    data: {},
    createdAt: '2026-10-26T08:00:00Z',
    ...over,
  };
};

const STEPS: AgentStep[] = [
  step('thinking', { content: 'Hmm. Maybe the duplicated heading is an artifact' }),
  step('text', { content: "I'll start by setting up the progress checklist." }),
  step('tool_call', {
    name: 'create_experiment',
    content: '{"title":"消融：去掉增强"}',
    data: { callId: 'c1' },
  }),
  step('tool_result', {
    name: 'create_experiment',
    content: '{"ok":true,"experiment_id":"exp_1","version":1}',
    data: { callId: 'c1', ok: true },
  }),
  step('tool_call', {
    name: 'edit_document',
    content: '{"doc_id":"doc_1","op":"replace_text","find":"旧","replace":"新"}',
    data: { callId: 'c2' },
  }),
  step('tool_result', {
    name: 'edit_document',
    content: '{"error":"文档里找不到这段原文","code":"not_found"}',
    data: { callId: 'c2', ok: false },
  }),
];

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgentStepsView
        steps={STEPS}
        isPending={false}
        error={null}
        onRetry={() => undefined}
        retrying={false}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe('AgentStepsView', () => {
  it('默认只显示中文摘要：不出工具名、英文思考和 JSON', () => {
    const { container } = renderView();
    expect(screen.getByText('新建了实验记录「消融：去掉增强」')).toBeTruthy();
    expect(screen.getByText('改了一份文档里的一处文字')).toBeTruthy();
    expect(screen.getByText('没成功：文档里找不到这段原文')).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).not.toContain('create_experiment');
    expect(text).not.toContain('edit_document');
    expect(text).not.toContain('Hmm');
    expect(text).not.toContain("I'll start");
    expect(text).not.toContain('{');
  });

  it('思考过程和原始数据点开才看得到', () => {
    const { container } = renderView();
    for (const b of screen.getAllByRole('button', { name: '查看思考过程' })) fireEvent.click(b);
    expect(screen.getByText(/Hmm\. Maybe/u)).toBeTruthy();
    expect(screen.getByText(/I'll start by/u)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '原始数据' })[0]!);
    expect(container.querySelector('pre')?.textContent).toContain('"title": "消融：去掉增强"');
  });

  it('余额不足出错：带「去充值」链接到 /billing', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AgentStepsView
            steps={[
              step('note', {
                name: 'error',
                content: '出错：余额不足，请先充值',
                data: { code: 'insufficient_credits' },
              }),
            ]}
            isPending={false}
            error={null}
            onRetry={() => undefined}
            retrying={false}
            hasOlder={false}
            loadingOlder={false}
            onLoadOlder={() => undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('link', { name: '去充值' }).getAttribute('href')).toBe('/billing');
  });
});
