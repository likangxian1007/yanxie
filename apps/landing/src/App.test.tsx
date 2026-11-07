import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('落地页', () => {
  it('渲染主标题与各区块', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(document.body.textContent).toContain('一个需求');
    expect(document.getElementById('how')).toBeInTheDocument();
    expect(document.getElementById('agents')).toBeInTheDocument();
    expect(document.getElementById('mobile')).toBeInTheDocument();
  });

  it('混合 AI 区块：往返示意、纯云端说明，且不泄露服务器地址', () => {
    render(<App />);
    expect(document.getElementById('hybrid')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).toContain('本地脱敏 → 云端推理 → 本地还原');
    expect(text).toContain('纯云端');
    expect(text).toContain('保版式翻译');
    const html = document.body.innerHTML;
    expect(html).not.toContain('64.177');
    expect(html).not.toContain(':8080');
    expect(html).not.toContain('localhost');
  });

  it('不出现已下线的说法', () => {
    render(<App />);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('云电脑');
    expect(text).not.toContain('实验记录');
  });
});

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

describe('落地页 · 英文', () => {
  it('英文模式下文本与无障碍属性中不出现中文（语言按钮的「中」除外）', () => {
    render(<App initialLang="en" />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Switch to Chinese' });
    const text = (document.body.textContent ?? '').replace(toggle.textContent ?? '', '');
    expect(text).not.toMatch(CJK);
    for (const el of Array.from(document.body.querySelectorAll('[aria-label],[alt],[title]'))) {
      for (const attr of ['aria-label', 'alt', 'title']) {
        expect(el.getAttribute(attr) ?? '').not.toMatch(CJK);
      }
    }
    expect(document.documentElement.lang).toBe('en');
  });

  it('点击语言按钮即时切换并记到 localStorage', () => {
    render(<App />);
    expect(document.body.textContent).toContain('一个需求');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));
    expect(document.body.textContent).toContain('From a one-line request');
    expect(localStorage.getItem('srh-lang')).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Chinese' }));
    expect(document.body.textContent).toContain('一个需求');
    expect(localStorage.getItem('srh-lang')).toBe('zh');
  });
});
