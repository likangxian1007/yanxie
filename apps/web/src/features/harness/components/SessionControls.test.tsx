import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentProfile, ModelCatalog, ModelInfo, ReasoningEffort } from '@srh/shared';
import { SessionControls } from './SessionControls';

const MODEL: ModelInfo = {
  id: 'ds/pro',
  providerId: 'ds',
  model: 'pro',
  name: 'Pro',
  description: null,
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
};
const CATALOG: ModelCatalog = {
  defaultModel: MODEL.id,
  defaultEffort: 'high',
  providers: [
    {
      id: 'ds',
      projectId: null,
      source: 'env',
      name: '模型',
      baseUrl: '',
      thinkingFormat: 'openai',
      hasApiKey: true,
      enabled: true,
      createdAt: null,
      models: [MODEL],
    },
  ],
};
const PROFILE: AgentProfile = {
  id: 'role',
  projectId: null,
  scope: 'builtin',
  ownerUserId: null,
  slug: 'review',
  name: '论文审阅',
  description: '检查论文的论证',
  icon: 'book',
  prompt: '',
  skills: [],
  starters: [],
  effort: 'high',
  updatedAt: null,
};

function Harness({
  onEffort = () => {},
  pending = false,
}: {
  onEffort?: (effort: ReasoningEffort) => void;
  pending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [effort, setEffort] = useState<ReasoningEffort>('high');
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  return (
    <SessionControls
      pending={pending}
      catalog={CATALOG}
      profiles={[PROFILE]}
      view={{ model: MODEL, effort, profile }}
      open={open}
      onOpenChange={setOpen}
      focus="model"
      onSelectModel={() => {}}
      onSelectEffort={(next) => {
        setEffort(next);
        onEffort(next);
      }}
      onSelectProfile={setProfile}
    />
  );
}

describe('SessionControls', () => {
  it('保存状态不替换或挤动底部模型摘要', () => {
    const view = render(<Harness />);
    const trigger = screen.getByRole('button', { name: /模型与推理强度/ });
    const original = trigger.innerHTML;
    fireEvent.click(trigger);
    view.rerender(<Harness pending />);
    expect(trigger.innerHTML).toBe(original);
    expect(screen.getByRole('status')).toHaveTextContent('保存中');
    view.rerender(<Harness pending={false} />);
    expect(trigger.innerHTML).toBe(original);
  });

  it('指针拖动只预览，释放后提交；键盘和刻度立即提交且面板保持打开', () => {
    const onEffort = vi.fn();
    render(<Harness onEffort={onEffort} />);
    const trigger = screen.getByRole('button', { name: /模型与推理强度/ });
    fireEvent.click(trigger);
    const slider = screen.getByRole('slider', { name: '推理强度' });
    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: '2' } });
    expect(slider).toHaveAttribute('aria-valuetext', '最高');
    expect(onEffort).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(onEffort).toHaveBeenCalledWith('max');
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.change(slider, { target: { value: '1' } });
    expect(onEffort).toHaveBeenLastCalledWith('high');
    fireEvent.click(screen.getByRole('button', { name: '推理强度：低' }));
    expect(onEffort).toHaveBeenLastCalledWith('low');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('指针取消时丢弃预览，之后仍可提交最后选择', () => {
    const onEffort = vi.fn();
    render(<Harness onEffort={onEffort} />);
    fireEvent.click(screen.getByRole('button', { name: /模型与推理强度/ }));
    const slider = screen.getByRole('slider', { name: '推理强度' });
    fireEvent.pointerDown(slider, { pointerId: 1 });
    fireEvent.change(slider, { target: { value: '2' } });
    fireEvent.pointerCancel(slider, { pointerId: 1 });
    expect(slider).toHaveAttribute('aria-valuetext', '高');
    expect(onEffort).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '推理强度：低' }));
    expect(onEffort).toHaveBeenCalledTimes(1);
    expect(onEffort).toHaveBeenCalledWith('low');
  });

  it('角色在可搜索的子页中选择，返回配置并可用 Esc 恢复焦点', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /模型与推理强度/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /科研角色.*通用/ }));
    const search = screen.getByRole('textbox', { name: '搜索科研角色' });
    fireEvent.change(search, { target: { value: '论证' } });
    const group = screen.getByRole('radiogroup', { name: '科研角色' });
    expect(within(group).queryByRole('radio', { name: '通用' })).toBeNull();
    fireEvent.click(within(group).getByRole('radio', { name: '论文审阅' }));
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: /科研角色.*论文审阅/ }),
    ).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('返回和显式关闭可在移动端使用', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /模型与推理强度/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /科研角色.*通用/ }));
    fireEvent.click(screen.getByRole('button', { name: '返回配置' }));
    expect(screen.getByText('会话配置')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭配置' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('点外部关闭时恢复触发器焦点，角色列表支持 Home 和 End', async () => {
    render(
      <>
        <Harness />
        <button type="button">外部</button>
      </>,
    );
    const trigger = screen.getByRole('button', { name: /模型与推理强度/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /科研角色.*通用/ }));
    const group = screen.getByRole('radiogroup', { name: '科研角色' });
    const general = within(group).getByRole('radio', { name: '通用' });
    const review = within(group).getByRole('radio', { name: '论文审阅' });
    const search = screen.getByRole('textbox', { name: '搜索科研角色' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(general).toHaveFocus();
    fireEvent.keyDown(general, { key: 'End' });
    expect(review).toHaveFocus();
    fireEvent.keyDown(review, { key: 'Home' });
    expect(general).toHaveFocus();
    fireEvent.pointerDown(screen.getByRole('button', { name: '外部' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
