import type { ReactElement } from 'react';
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { YDOC_FIELD, type DocumentAiInput, type DocumentMeta } from '@srh/shared';
import type * as UiModule from '@/components/ui';
import type { CollabDoc } from '../../collab/useCollabDoc';
import { LatexEditor } from './LatexEditor';

// AI：可控的假实现，run 返回的 promise 由测试手动结束（模拟流式生成中）
const aiState = vi.hoisted(() => ({
  status: 'idle' as 'idle' | 'streaming' | 'done' | 'error',
  text: '',
  calls: [] as unknown[],
  finish: null as null | ((text: string) => void),
  rerender: null as null | (() => void),
}));
vi.mock('../../ai/useDocAi', async () => {
  const React = await import('react');
  return {
    readLocalOnly: () => false,
    writeLocalOnly: () => {},
    routeLabel: () => '',
    useDocAi: () => {
      const [, force] = React.useReducer((x: number) => x + 1, 0);
      aiState.rerender = force;
      return {
        status: aiState.status,
        text: aiState.text,
        error: null,
        run: (input: unknown) => {
          aiState.calls.push(input);
          aiState.status = 'streaming';
          aiState.text = '';
          return new Promise<string>((resolve) => {
            aiState.finish = (text: string) => {
              aiState.status = 'done';
              aiState.text = text;
              force();
              resolve(text);
            };
          });
        },
        stop: () => {},
        reset: () => {
          aiState.status = 'idle';
          aiState.text = '';
        },
      };
    },
  };
});

// 编译：假实现。初始结果是报告里的「第 2 行 Missing \begin{document}」；compile() 后换成 nextIssues
const compileState = vi.hoisted(() => ({
  issues: [] as unknown[],
  nextIssues: [] as unknown[],
  result: null as unknown,
  compiles: 0,
  rerender: null as null | (() => void),
}));
vi.mock('./compile/useLatexCompile', async () => {
  const React = await import('react');
  return {
    useLatexCompile: () => {
      const [, force] = React.useReducer((x: number) => x + 1, 0);
      compileState.rerender = force;
      return {
        capability: { available: true },
        probing: false,
        available: true,
        compiling: false,
        result: compileState.result,
        pdf: null,
        error: null,
        issues: compileState.issues,
        stale: false,
        auto: false,
        setAuto: () => {},
        compile: async () => {
          compileState.compiles += 1;
          compileState.issues = compileState.nextIssues;
          compileState.result = { status: 'ok', log: '', pdfId: null, n: compileState.compiles };
          force();
        },
      };
    },
  };
});

const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/ui', async (orig) => {
  const mod = await orig<typeof UiModule>();
  const toast = Object.assign(
    (o: unknown) => {
      toasts.push(o);
      return 0;
    },
    {
      success: (title: unknown) => toasts.push({ title, tone: 'success' }),
      error: (title: unknown) => toasts.push({ title, tone: 'danger' }),
    },
  );
  return { ...mod, toast };
});

const MISSING_BEGIN = {
  severity: 'error',
  file: 'main.tex',
  line: 2,
  message: 'Missing \\begin{document}',
  kind: 'other',
  fixable: true,
  raw: '! LaTeX Error: Missing \\begin{document}.',
};
const UNDEFINED = {
  ...MISSING_BEGIN,
  line: 7,
  message: '未定义的命令 \\undefinedcmd（拼写错误，或者忘了加载宏包）',
};

function resetCompile() {
  compileState.issues = [MISSING_BEGIN, UNDEFINED];
  compileState.nextIssues = [UNDEFINED];
  compileState.result = { status: 'error', log: '', pdfId: null, n: 0 };
  compileState.compiles = 0;
  toasts.length = 0;
  window.localStorage.setItem('srh:latex:preview-kind', 'draft');
}

/** 终验缺陷 #9 的真实情形 */
const SOURCE = String.raw`\documentclass{ctexart}
导师补充 ADV-TEX \undefinedcmd{x} 参见 \cite{nokey2099}。
\usepackage{amsmath,graphicx}
\title{图对比学习综述（验收）}
\author{张三}
\begin{document}
\maketitle
\section{引言}
图对比学习近年发展迅速。
\section{方法}
正文。
\end{document}`;
const LINES = SOURCE.split('\n');

function makeCollab(doc: Y.Doc) {
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', { name: '我', color: 'var(--palette-0)' });
  const provider = { setAwarenessField: vi.fn(), awareness };
  return {
    doc,
    provider: provider as unknown as CollabDoc['provider'],
    status: 'connected',
    synced: true,
    me: { id: 'u1', name: '我', color: 'var(--palette-0)', colorIndex: 0, kind: 'user' },
    peers: [],
  } satisfies CollabDoc;
}

const meta = { id: 'd1', title: '论文', kind: 'latex' } as unknown as DocumentMeta;

function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeAll(() => {
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  const rect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects ??= empty as unknown as () => DOMRectList;
  Range.prototype.getBoundingClientRect ??= rect;
});

async function openFixForLine2() {
  fireEvent.click(await screen.findByRole('button', { name: /个编译问题/u }));
  const list = await screen.findByRole('list', { name: '编译日志里的问题' });
  const item = [...list.querySelectorAll('li')].find((li) => li.textContent?.includes('第 2 行'));
  expect(item).toBeTruthy();
  const fix = [...item!.querySelectorAll('button')].find((b) => b.textContent?.includes('修复'));
  fireEvent.click(fix!);
}

describe('LatexEditor 让 AI 修复', () => {
  it('导言区里的问题：把第 1 行到 \\begin{document} 之后交给 AI；生成中不能替换；会删掉 \\documentclass 的结果被拒绝', async () => {
    resetCompile();
    const doc = new Y.Doc();
    const ytext = doc.getText(YDOC_FIELD.latex);
    ytext.insert(0, SOURCE);
    render(<LatexEditor projectId="p" docId="d1" meta={meta} collab={makeCollab(doc)} editable />);

    await openFixForLine2();
    await waitFor(() => expect(aiState.calls.length).toBe(1));
    const input = aiState.calls[0] as DocumentAiInput;
    expect(input.action).toBe('latex_fix');
    expect(input.selection).toBe(LINES.slice(0, 9).join('\n'));
    expect(input.prompt).toContain('片段起始行：1');

    // 生成中：替换按钮禁用，显示「正在生成…」
    const card = await screen.findByRole('region', { name: /AI 修复第 2 行/u });
    expect(card).toHaveTextContent('含导言区');
    expect(screen.getByRole('button', { name: /正在生成…/u })).toBeDisabled();

    // AI 返回报告里那种删掉 \documentclass 的结果
    await act(async () => aiState.finish?.(LINES.slice(1, 9).join('\n')));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'AI 给的修改会删掉 \\documentclass，没有应用',
    );
    const replace = screen.getByRole('button', { name: '替换第 1–9 行' });
    expect(replace).toBeDisabled();
    fireEvent.click(replace);
    expect(ytext.toString()).toBe(SOURCE);
    expect(screen.getByRole('button', { name: '仍然查看差异' })).toBeInTheDocument();
  }, 20_000);

  it('正确的修复：显示差异，替换后 \\documentclass 保留、误放的行移到正文', async () => {
    aiState.calls = [];
    resetCompile();
    const doc = new Y.Doc();
    const ytext = doc.getText(YDOC_FIELD.latex);
    ytext.insert(0, SOURCE);
    const { container } = render(
      <LatexEditor projectId="p" docId="d1" meta={meta} collab={makeCollab(doc)} editable />,
    );
    await openFixForLine2();
    await waitFor(() => expect(aiState.calls.length).toBe(1));
    const fixed = [LINES[0], ...LINES.slice(2, 7), LINES[1], LINES[7], LINES[8]].join('\n');
    await act(async () => aiState.finish?.(fixed));
    await waitFor(() =>
      expect(container.querySelectorAll('li[data-kind="add"]').length).toBeGreaterThan(0),
    );
    const replace = screen.getByRole('button', { name: '替换第 1–9 行' });
    expect(replace).toBeEnabled();
    fireEvent.click(replace);
    const next = ytext.toString();
    expect(next.startsWith('\\documentclass{ctexart}\n\\usepackage')).toBe(true);
    expect(next.indexOf('ADV-TEX')).toBeGreaterThan(next.indexOf('\\begin{document}'));
    // 应用后自动重新编译一次，并告诉用户错误数的变化
    await waitFor(() => expect(compileState.compiles).toBe(1));
    await waitFor(() =>
      expect(toasts).toContainEqual(
        expect.objectContaining({ title: '错误从 2 个减到 1 个', tone: 'success' }),
      ),
    );
  }, 20_000);
});
