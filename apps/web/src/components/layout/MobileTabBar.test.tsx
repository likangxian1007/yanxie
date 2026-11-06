import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutStore } from './layout-store';
import { activeTabKey, MORE_NAV, opensSoftKeyboard, TABBAR_LABEL } from './mobile-tabbar';
import { installFakeBackend, PID, renderShell } from './shell-test-utils';

describe('手机底部标签栏：纯逻辑', () => {
  it('按路由第一段判断当前标签，协作台只认项目根', () => {
    expect(activeTabKey(`/p/${PID}`, PID)).toBe('timeline');
    expect(activeTabKey(`/p/${PID}/`, PID)).toBe('timeline');
    expect(activeTabKey(`/p/${PID}/threads/thr_1`, PID)).toBe('threads');
    expect(activeTabKey(`/p/${PID}/inbox`, PID)).toBe('inbox');
    expect(activeTabKey(`/p/${PID}/reviews/rev_1`, PID)).toBe('reviews');
    expect(activeTabKey(`/p/${PID}/docs/doc_1`, PID)).toBe('more');
    expect(activeTabKey(`/p/${PID}/help`, PID)).toBe('more');
    expect(activeTabKey(`/p/other/threads`, PID)).toBeNull();
    expect(activeTabKey('/login', PID)).toBeNull();
  });

  it('「更多」里是标签栏以外的页面，含设置和帮助，不重复标签栏里的', () => {
    const labels = MORE_NAV.map((i) => i.label);
    expect(labels).toEqual(
      expect.arrayContaining(['文档', '任务', '研究空间', '组会汇报', '设置', '帮助']),
    );
    expect(labels).not.toContain('实验');
    expect(labels).not.toContain('云电脑');
    expect(labels).not.toContain('协作台');
    expect(labels).not.toContain('线程');
    expect(labels).not.toContain('审阅');
  });

  it('只有可输入的元素才算会弹软键盘', () => {
    const text = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const ro = document.createElement('textarea');
    ro.readOnly = true;
    const ce = document.createElement('div');
    ce.contentEditable = 'true';
    expect(opensSoftKeyboard(text)).toBe(true);
    expect(opensSoftKeyboard(document.createElement('textarea'))).toBe(true);
    expect(opensSoftKeyboard(box)).toBe(false);
    expect(opensSoftKeyboard(ro)).toBe(false);
    expect(opensSoftKeyboard(document.createElement('button'))).toBe(false);
    expect(opensSoftKeyboard(null)).toBe(false);
    // jsdom 不实现 isContentEditable，这里只验证不会抛错
    expect(typeof opensSoftKeyboard(ce)).toBe('boolean');
  });
});

describe('手机底部标签栏：外壳里', () => {
  beforeEach(() => {
    useLayoutStore.setState({ paletteOpen: false, mobileNavOpen: false });
    installFakeBackend();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('五个入口齐全，协作台高亮', async () => {
    renderShell();
    const bar = await screen.findByRole('navigation', { name: TABBAR_LABEL });
    for (const name of ['协作台', '线程', '待我处理', '审阅']) {
      expect(within(bar).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(within(bar).getByRole('link', { name: '协作台' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(bar).getByRole('button', { name: '更多页面' })).toBeInTheDocument();
  });

  it('点「更多」升起底部面板，点里面的页面后面板收起', async () => {
    renderShell();
    const bar = await screen.findByRole('navigation', { name: TABBAR_LABEL });
    const more = within(bar).getByRole('button', { name: '更多页面' });
    fireEvent.click(more);
    const sheet = await screen.findByRole('dialog', { name: '更多' });
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(sheet).getByRole('link', { name: '帮助' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '更多' })).toBeNull());
  });

  it('输入框获得焦点（软键盘弹起）时标签栏收起，失焦后回来', async () => {
    renderShell();
    await screen.findByRole('navigation', { name: TABBAR_LABEL });
    const input = document.createElement('textarea');
    document.body.append(input);
    fireEvent.focusIn(input);
    await waitFor(() =>
      expect(screen.queryByRole('navigation', { name: TABBAR_LABEL })).toBeNull(),
    );
    fireEvent.focusOut(input, { relatedTarget: null });
    expect(await screen.findByRole('navigation', { name: TABBAR_LABEL })).toBeInTheDocument();
    input.remove();
  });
});
