import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// pnpm check 会并行跑三个包的测试，机器忙时异步渲染变慢：findBy / waitFor 多等一会儿，避免偶发超时
configure({ asyncUtilTimeout: 5000 });

// jsdom 没有 matchMedia：默认“桌面宽度、浅色、不减少动态效果”
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// motion 的部分特性会用到这些观察者
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
if (!('ResizeObserver' in window)) {
  vi.stubGlobal('ResizeObserver', NoopObserver);
}
if (!('IntersectionObserver' in window)) {
  vi.stubGlobal('IntersectionObserver', NoopObserver);
}

window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
