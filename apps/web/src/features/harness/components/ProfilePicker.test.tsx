import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { AgentProfile } from '@srh/shared';
import { ProfilePicker } from './ProfilePicker';
it('makes all roles reachable, searchable and keyboard accessible without a horizontal strip', async () => {
  const profiles: AgentProfile[] = Array.from({ length: 20 }, (_, i) => ({
    slug: `role-${i}`,
    name: `科研角色 ${i}`,
    description: `角色说明 ${i}`,
    icon: 'sparkles',
    id: `profile-${i}`,
    projectId: null,
    scope: 'builtin',
    ownerUserId: null,
    prompt: '',
    skills: [],
    starters: [],
    effort: null,
    updatedAt: null,
  }));
  const onChange = vi.fn();
  render(<ProfilePicker profiles={profiles} value={null} onChange={onChange} />);
  const trigger = screen.getByRole('button', { name: '科研角色：通用' });
  fireEvent.click(trigger);
  expect(screen.getAllByRole('radio')).toHaveLength(21);
  fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'End' });
  expect(screen.getByRole('radio', { name: '科研角色 19' })).toHaveFocus();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索科研角色' }), {
    target: { value: '角色 19' },
  });
  expect(screen.getAllByRole('radio')).toHaveLength(1);
  fireEvent.click(screen.getByRole('radio'));
  expect(onChange).toHaveBeenCalledWith('role-19');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(trigger).toHaveFocus();
});
