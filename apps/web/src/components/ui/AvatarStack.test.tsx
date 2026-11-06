import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AvatarStack } from './AvatarStack';
it('opens one list only on activation and restores keyboard focus', async () => {
  render(
    <AvatarStack
      members={[
        { id: 'b', name: '乙' },
        { id: 'a', name: '甲' },
        { id: 'a', name: '甲' },
        { id: 'c', name: '丙' },
        { id: 'd', name: '丁' },
      ]}
    />,
  );
  const button = screen.getByRole('button', { name: '当前资源在线成员：4 人' });
  fireEvent.pointerEnter(button);
  fireEvent.focus(button);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('+1')).toBeInTheDocument();
  fireEvent.click(button);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getAllByRole('listitem')).toHaveLength(4);
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(button).toHaveFocus();
});
describe('empty resource presence', () => {
  it('has no misleading empty control', () => {
    const { container } = render(<AvatarStack members={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
