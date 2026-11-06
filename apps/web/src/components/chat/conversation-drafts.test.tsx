import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { appendAgentDraft, useConversationDraft } from './conversation-drafts';

describe('conversation draft isolation', () => {
  it('isolates account, project, thread and channel and quotes into existing agent draft', () => {
    const agent = renderHook(() => useConversationDraft('p', 't', 'u'));
    const team = renderHook(() => useConversationDraft('p', 't', 'u', 'team'));
    const other = renderHook(() => useConversationDraft('p', 't', 'v', 'team'));
    act(() => {
      agent.result.current[1]('尚未发送的需求');
      team.result.current[1]('尚未发送的讨论');
    });
    act(() => appendAgentDraft('p', 't', 'u', '引用同事：\n> 研究记录'));
    expect(agent.result.current[0]).toBe('尚未发送的需求\n\n引用同事：\n> 研究记录');
    expect(team.result.current[0]).toBe('尚未发送的讨论');
    expect(other.result.current[0]).toBe('');
    team.unmount();
    expect(renderHook(() => useConversationDraft('p', 't', 'u', 'team')).result.current[0]).toBe(
      '尚未发送的讨论',
    );
  });
});
