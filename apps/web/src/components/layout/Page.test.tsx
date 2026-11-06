import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageActions, PageTitle, PageTitleProvider } from './Page';
import { usePageTitle } from './page-title';

describe('PageActions', () => {
  it('外壳中把页面操作移入顶栏插槽，只渲染一份', () => {
    render(
      <>
        <header>
          <div id="page-actions" data-testid="actions" />
        </header>
        <main>
          <PageActions>
            <button>新建线程</button>
          </PageActions>
        </main>
      </>,
    );
    expect(
      within(screen.getByTestId('actions')).getByRole('button', { name: '新建线程' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '新建线程' })).toHaveLength(1);
    expect(screen.getByRole('main')).toBeEmptyDOMElement();
  });
  it('独立页面没有顶栏插槽时保留可操作按钮', () => {
    render(
      <main>
        <PageActions>
          <button>新建线程</button>
        </PageActions>
      </main>,
    );
    expect(
      within(screen.getByRole('main')).getByRole('button', { name: '新建线程' }),
    ).toBeInTheDocument();
  });
});

function TitleHost() {
  const title = usePageTitle();
  return (
    <header>
      <h1>{title ?? '默认标题'}</h1>
    </header>
  );
}
describe('PageTitle', () => {
  it('外壳接收动态标题，更新和卸载后同步恢复', () => {
    const view = render(
      <PageTitleProvider>
        <TitleHost />
        <main>
          <PageTitle>线程甲</PageTitle>
        </main>
      </PageTitleProvider>,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: '线程甲' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeEmptyDOMElement();
    view.rerender(
      <PageTitleProvider>
        <TitleHost />
        <main>
          <PageTitle>线程乙</PageTitle>
        </main>
      </PageTitleProvider>,
    );
    expect(screen.getByRole('heading', { level: 1, name: '线程乙' })).toBeInTheDocument();
    view.rerender(
      <PageTitleProvider>
        <TitleHost />
        <main />
      </PageTitleProvider>,
    );
    expect(screen.getByRole('heading', { level: 1, name: '默认标题' })).toBeInTheDocument();
  });
  it('独立页面保留动态主标题', () => {
    render(<PageTitle>线程标题</PageTitle>);
    expect(screen.getByRole('heading', { level: 1, name: '线程标题' })).toBeInTheDocument();
  });
});
