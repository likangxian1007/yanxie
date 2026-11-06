import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NbOutput } from '@srh/shared';
import { imageMeta, WIDGET_MIME } from '../outputs';
import { CellOutputs } from './CellOutputs';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('CellOutputs 图片', () => {
  it('没有尺寸信息时不写死宽高（按原始像素显示，CSS 只限制最大宽度）', () => {
    const outputs = [
      { output_type: 'display_data', data: { 'image/png': PNG }, metadata: {} },
    ] as unknown as NbOutput[];
    render(<CellOutputs outputs={outputs} />);
    const img = screen.getByRole('img', { name: '输出图像' });
    expect(img).toHaveClass('nb-image');
    expect(img.getAttribute('width')).toBeNull();
    expect(img.getAttribute('height')).toBeNull();
  });

  it('retina 图按 metadata 里的显示尺寸', () => {
    const outputs = [
      {
        output_type: 'display_data',
        data: { 'image/png': PNG },
        metadata: { 'image/png': { width: 347, height: 297 } },
      },
    ] as unknown as NbOutput[];
    render(<CellOutputs outputs={outputs} />);
    const img = screen.getByRole('img', { name: '输出图像' });
    expect(img.getAttribute('width')).toBe('347');
    expect(img.getAttribute('height')).toBe('297');
  });

  it('imageMeta 认按 MIME 分的和顶层的尺寸，忽略非法值', () => {
    expect(imageMeta({ 'image/png': { width: 200.4, height: 100 } }, 'image/png')).toEqual({
      width: 200,
      height: 100,
      unconfined: undefined,
    });
    expect(imageMeta({ width: 50 }, 'image/png').width).toBe(50);
    expect(imageMeta({ 'image/png': { width: -1, height: 'x' } }, 'image/png')).toEqual({
      width: undefined,
      height: undefined,
      unconfined: undefined,
    });
    expect(imageMeta({ 'image/png': { unconfined: true } }, 'image/png').unconfined).toBe(true);
  });
});

describe('CellOutputs 交互控件和进度条', () => {
  it('ipywidgets 控件：显示文本结果和说明', () => {
    const outputs = [
      {
        output_type: 'display_data',
        data: {
          [WIDGET_MIME]: { model_id: 'abc', version_major: 2, version_minor: 0 },
          'text/plain': 'IntSlider(value=3)',
        },
        metadata: {},
      },
    ] as unknown as NbOutput[];
    render(<CellOutputs outputs={outputs} />);
    expect(screen.getByText('交互控件暂不支持，显示文本结果。')).toBeInTheDocument();
    expect(screen.getByText('IntSlider(value=3)')).toBeInTheDocument();
  });

  it('tqdm 控件进度条：说明不会更新，并提示改用文本进度条', () => {
    const outputs = [
      {
        output_type: 'display_data',
        data: { [WIDGET_MIME]: { model_id: 'p' }, 'text/plain': '  0%|          | 0/20' },
        metadata: {},
      },
    ] as unknown as NbOutput[];
    render(<CellOutputs outputs={outputs} />);
    expect(screen.getByText(/交互进度条暂不支持/)).toHaveTextContent('from tqdm import tqdm');
  });

  it('只有控件、没有文本时也有说明，不是一片空白', () => {
    const outputs = [
      { output_type: 'display_data', data: { [WIDGET_MIME]: { model_id: 'q' } }, metadata: {} },
    ] as unknown as NbOutput[];
    const { container } = render(<CellOutputs outputs={outputs} />);
    expect(container.textContent).toContain('交互控件暂不支持');
  });

  it('文本进度条（stderr + \\r）原地更新到最后一次', () => {
    const outputs = [
      {
        output_type: 'stream',
        name: 'stderr',
        text: '  0%|          | 0/20\r 50%|#####     | 10/20\r100%|##########| 20/20\n',
      },
    ] as unknown as NbOutput[];
    const { container } = render(<CellOutputs outputs={outputs} />);
    const pre = container.querySelector('.nb-stderr');
    expect(pre?.textContent).toBe('100%|##########| 20/20\n');
  });

  it('HTML 输出里的 script 和 onerror 不进页面', () => {
    const outputs = [
      {
        output_type: 'display_data',
        data: {
          'text/html': '<img src=x onerror="window.__xss=1"><script>window.__xss2=1</script>',
        },
        metadata: {},
      },
    ] as unknown as NbOutput[];
    const { container } = render(<CellOutputs outputs={outputs} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  });
});
