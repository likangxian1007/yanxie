import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mergeAnnotationRects } from './annotation-geometry';
import { AnnotationMarks } from './AnnotationMarks';

describe('重叠标注显示', () => {
  it('同一行的文本框与元素框合并，避免同一句出现两条下划线', () => {
    const input = [
      { left: 72, top: 60, width: 100, height: 14 },
      { left: 72, top: 59, width: 100, height: 16 },
      { left: 140, top: 60, width: 90, height: 14 },
    ];
    expect(mergeAnnotationRects(input)).toEqual([{ left: 72, top: 59, width: 158, height: 16 }]);
    expect(input[0]).toEqual({ left: 72, top: 60, width: 100, height: 14 });
  });
  it.each([0.5, 1, 2])('%s 倍显示保留相邻行和双栏间隙，不把整段拼成大色块', (scale) => {
    const rects = [
      { left: 72, top: 60, width: 100, height: 14 },
      { left: 72, top: 78, width: 100, height: 14 },
      { left: 320, top: 60, width: 100, height: 14 },
    ].map((r) => ({
      left: r.left * scale,
      top: r.top * scale,
      width: r.width * scale,
      height: r.height * scale,
    }));
    expect(mergeAnnotationRects(rects)).toHaveLength(3);
  });
  it('重复区域共用透明度层，同时保留每条标注身份和当前条目的强调轮廓', () => {
    const rect = { left: 72, top: 60, width: 100, height: 14 };
    const { container } = render(
      <AnnotationMarks
        marks={[
          { key: 'a', tone: 'highlight', color: 'yellow', rect },
          { key: 'a', tone: 'highlight', color: 'yellow', rect },
          { key: 'b', tone: 'highlight', color: 'green', rect, active: true },
          { key: 'c', tone: 'comment', color: 'blue', rect },
        ]}
      />,
    );
    expect(container.querySelectorAll('.lib-annotation-fills')).toHaveLength(1);
    expect(container.querySelectorAll('.lib-annotation-fills [data-annotation-mark]')).toHaveLength(
      2,
    );
    expect(
      container.querySelector('[data-annotation-mark="a"]')?.getAttribute('d')?.match(/M/g),
    ).toHaveLength(1);
    expect(container.querySelector('[data-annotation-mark="c"]')).toHaveClass(
      'lib-annotation-comment',
    );
    expect(container.querySelectorAll('[data-annotation-active]')).toHaveLength(1);
    expect(container.querySelector('[data-annotation-active]')).toHaveAttribute(
      'data-annotation-active',
      'b',
    );
  });
});
