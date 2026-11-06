import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { checkLatexReplacement } from '../ai/fixGuard';
import { LatexAiCard, type LatexAiPhase, type LatexAiTask } from './LatexAiCard';

const ORIGINAL = String.raw`\documentclass{ctexart}
导师补充 ADV-TEX \undefinedcmd{x} 参见 \cite{nokey2099}。
\usepackage{amsmath,graphicx}
\begin{document}
\maketitle`;

/** 报告里 AI 的错误输出：第 1 行 \documentclass 被删 */
const BAD = String.raw`导师补充 ADV-TEX \undefinedcmd{x} 参见 \cite{nokey2099}。
\usepackage{amsmath,graphicx}
\begin{document}
\maketitle`;

const GOOD = String.raw`\documentclass{ctexart}
\usepackage{amsmath,graphicx}
\begin{document}
\maketitle
导师补充 ADV-TEX 参见 \cite{nokey2099}。`;

const TASK: LatexAiTask = {
  title: '修复第 2 行',
  detail: 'Missing \\begin{document}',
  canReplace: true,
  replaceLabel: '替换第 1–5 行',
  preferDiff: true,
};

function setup(phase: LatexAiPhase, text: string, opts: { withCheck?: boolean } = {}) {
  const onReplace = vi.fn();
  const check =
    opts.withCheck && text.trim()
      ? checkLatexReplacement(ORIGINAL, 0, ORIGINAL.length, text)
      : null;
  const utils = render(
    <LatexAiCard
      phase={phase}
      error={null}
      task={TASK}
      text={text}
      editable
      original={{ text: ORIGINAL, startLine: 1 }}
      check={check}
      onStop={vi.fn()}
      onReplace={onReplace}
      onInsert={vi.fn()}
      onRetry={vi.fn()}
      onDiscard={vi.fn()}
    />,
  );
  return { ...utils, onReplace };
}

describe('LatexAiCard', () => {
  it('生成中（还没有内容）：替换按钮禁用并显示「正在生成…」', () => {
    const { onReplace } = setup('streaming', '');
    const btn = screen.getByRole('button', { name: /正在生成…/u });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onReplace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /插入到光标处/u })).toBeDisabled();
    expect(screen.getByRole('button', { name: /复制/u })).toBeDisabled();
    expect(screen.getByText('正在读这段 LaTeX')).toBeInTheDocument();
  });

  it('流式输出到一半：替换仍然禁用', () => {
    setup('streaming', GOOD.slice(0, 30));
    expect(screen.getByRole('button', { name: /正在生成…/u })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '替换第 1–5 行' })).not.toBeInTheDocument();
  });

  it('生成结束但结果为空：替换禁用', () => {
    setup('done', '   ');
    expect(screen.getByRole('button', { name: '替换第 1–5 行' })).toBeDisabled();
    expect(screen.getByText('AI 没有生成内容，可以重新生成一次。')).toBeInTheDocument();
  });

  it('生成被停止：只能复制，不能替换', () => {
    setup('stopped', GOOD.slice(0, 40));
    expect(screen.getByRole('button', { name: '替换第 1–5 行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /复制/u })).toBeEnabled();
    expect(screen.getByText('已停止生成，结果可能不完整')).toBeInTheDocument();
  });

  it('校验通过：默认显示差异，可以替换', () => {
    const { onReplace, container } = setup('done', GOOD, { withCheck: true });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(container.querySelectorAll('li[data-kind="del"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('li[data-kind="add"]').length).toBeGreaterThan(0);
    const btn = screen.getByRole('button', { name: '替换第 1–5 行' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it('会删掉 \\documentclass：拒绝一键替换，看过差异后才能「仍然替换」', () => {
    const { onReplace, container } = setup('done', BAD, { withCheck: true });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'AI 给的修改会删掉 \\documentclass，没有应用',
    );
    const replace = screen.getByRole('button', { name: '替换第 1–5 行' });
    expect(replace).toBeDisabled();
    fireEvent.click(replace);
    expect(onReplace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '仍然查看差异' }));
    const deleted = [...container.querySelectorAll('li[data-kind="del"]')].map(
      (li) => li.textContent,
    );
    expect(deleted.some((t) => t?.includes('\\documentclass{ctexart}'))).toBe(true);
    const force = screen.getByRole('button', { name: '仍然替换' });
    expect(force).toBeEnabled();
    fireEvent.click(force);
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it('切到「全文」时不能强制替换', () => {
    setup('done', BAD, { withCheck: true });
    fireEvent.click(screen.getByRole('button', { name: '仍然查看差异' }));
    fireEvent.click(screen.getByRole('button', { name: '全文' }));
    expect(screen.getByRole('button', { name: '替换第 1–5 行' })).toBeDisabled();
  });
});
