import { fireEvent, render, screen } from '@testing-library/react';
import type { ReviewParticipant } from '@srh/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerdictPanel } from './VerdictPanel';

const mutate = vi.fn();

vi.mock('../api', () => ({
  useSubmitVerdict: () => ({ mutate, isPending: false }),
}));

const ME = { userId: 'usr_me', verdict: 'pending' } as ReviewParticipant;

describe('VerdictPanel', () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  it('「要求修改」没写原因时不提交，提示必填并聚焦说明框', () => {
    vi.useFakeTimers();
    render(<VerdictPanel pid="prj_1" reviewId="rev_1" me={ME} />);
    fireEvent.click(screen.getByRole('button', { name: '要求修改' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('写一句要改什么');
    const note = screen.getByRole('textbox');
    expect(note).toHaveAttribute('aria-invalid', 'true');
    vi.runAllTimers();
    expect(document.activeElement).toBe(note);
    vi.useRealTimers();
  });

  it('写了原因再点「要求修改」才提交，并带上原因', () => {
    render(<VerdictPanel pid="prj_1" reviewId="rev_1" me={ME} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '样本量不够' } });
    fireEvent.click(screen.getByRole('button', { name: '要求修改' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      verdict: 'changes_requested',
      comment: '样本量不够',
    });
  });

  it('LGTM 不需要说明', () => {
    render(<VerdictPanel pid="prj_1" reviewId="rev_1" me={ME} />);
    fireEvent.click(screen.getByRole('button', { name: /LGTM/ }));
    expect(mutate).toHaveBeenCalledWith({ verdict: 'lgtm' }, expect.anything());
  });
});
