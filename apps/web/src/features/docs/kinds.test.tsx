import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_KIND_LABEL, DocumentKind } from '@srh/shared';
import { DOC_KIND_META, DOC_KINDS, DocKindIcon } from './kinds';

describe('DOC_KIND_META', () => {
  it('覆盖全部文档类型，标签与契约一致，色板序号合法', () => {
    expect([...DOC_KINDS].sort()).toEqual([...DocumentKind.options].sort());
    for (const kind of DocumentKind.options) {
      const meta = DOC_KIND_META[kind];
      expect(meta.label).toBe(DOCUMENT_KIND_LABEL[kind]);
      expect(meta.description).not.toBe('');
      expect(meta.tone).toBeGreaterThanOrEqual(0);
      expect(meta.tone).toBeLessThanOrEqual(7);
    }
    expect(new Set(DOC_KINDS.map((k) => DOC_KIND_META[k].tone)).size).toBe(4);
  });
});

describe('DocKindIcon', () => {
  it('默认作装饰；传 label 时可被读屏读出，并使用色板色', () => {
    const { container } = render(<DocKindIcon kind="sheet" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');

    render(<DocKindIcon kind="latex" size="lg" label="LaTeX 论文" />);
    const icon = screen.getByRole('img', { name: 'LaTeX 论文' });
    expect(icon).toHaveAttribute('data-kind', 'latex');
    expect(icon.getAttribute('style')).toContain('var(--palette-3)');
  });
});
