import { afterEach, describe, expect, it } from 'vitest';
import { placeCard, resolveTarget, sheetDock, spotlightRect } from './geometry';
import { introForPath } from './module-intros';
import {
  INTRO_MAX_VIEWS,
  autoStartEnabled,
  configureOnboarding,
  introKey,
  readIntroRecord,
  readTourRecord,
  shouldShowIntro,
  tourKey,
  writeTourRecord,
} from './storage';
import { useTourStore } from './tour-store';
import { clampStep, stepsFor, tourVariantForRole, type TourStep } from './tour-steps';

const U = 'usr_1';
const P = 'prj_1';

afterEach(() => {
  useTourStore.setState({ active: null, welcomeOpen: false, request: null });
  configureOnboarding(null);
});

describe('角色 → 引导版本', () => {
  it('负责人和成员看完整版，导师看导师版，访客看只读版', () => {
    expect(tourVariantForRole('owner')).toBe('member');
    expect(tourVariantForRole('member')).toBe('member');
    expect(tourVariantForRole('advisor')).toBe('advisor');
    expect(tourVariantForRole('guest')).toBe('guest');
    expect(tourVariantForRole(null)).toBe('member');
  });

  it('各版本覆盖要求的模块', () => {
    expect(stepsFor('member').map((s) => s.id)).toEqual([
      'coordinator',
      'threads',
      'workspace',
      'docs',
      'reviews',
      'reports',
      'inbox',
      'search',
    ]);
    const advisor = stepsFor('advisor').map((s) => s.id);
    expect(advisor).toEqual(
      expect.arrayContaining(['coordinator', 'threads', 'inbox', 'reviews', 'reports', 'phone']),
    );
    expect(stepsFor('guest').length).toBeLessThan(stepsFor('member').length);
    for (const v of ['member', 'advisor', 'guest'] as const) {
      for (const s of stepsFor(v)) {
        expect(s.title).not.toMatch(/您|！/u);
        expect(s.body).not.toMatch(/您|！/u);
      }
    }
  });

  it('步数夹在有效范围', () => {
    expect(clampStep('member', -3)).toBe(0);
    expect(clampStep('member', 99)).toBe(stepsFor('member').length - 1);
    expect(clampStep('advisor', 2.7)).toBe(2);
  });
});

describe('引导进度与持久化', () => {
  it('前进、后退、跳过都会写 localStorage', () => {
    const s = useTourStore.getState();
    s.start({ userId: U, projectId: P, variant: 'member' });
    expect(readTourRecord(U, P)).toMatchObject({ status: 'active', step: 0, variant: 'member' });

    useTourStore.getState().next();
    useTourStore.getState().next();
    expect(useTourStore.getState().active?.step).toBe(2);
    expect(readTourRecord(U, P)?.step).toBe(2);

    useTourStore.getState().prev();
    expect(readTourRecord(U, P)?.step).toBe(1);

    useTourStore.getState().skip();
    expect(useTourStore.getState().active).toBeNull();
    expect(readTourRecord(U, P)).toMatchObject({ status: 'skipped', step: 1 });
  });

  it('最后一步点下一步 = 完成', () => {
    const last = stepsFor('advisor').length - 1;
    useTourStore.getState().start({ userId: U, projectId: P, variant: 'advisor', step: last });
    useTourStore.getState().next();
    expect(useTourStore.getState().active).toBeNull();
    expect(readTourRecord(U, P)).toMatchObject({ status: 'done', variant: 'advisor' });
  });

  it('第一步不能再后退', () => {
    useTourStore.getState().start({ userId: U, projectId: P, variant: 'guest' });
    useTourStore.getState().prev();
    expect(useTourStore.getState().active?.step).toBe(0);
  });

  it('按用户 × 课题分开记录，坏数据当作没有', () => {
    writeTourRecord(U, P, { status: 'done', step: 3, variant: 'member' });
    expect(readTourRecord(U, 'prj_2')).toBeNull();
    expect(readTourRecord('usr_2', P)).toBeNull();
    expect(tourKey(U, P)).toBe('srh-onboarding:v1:usr_1:prj_1');
    window.localStorage.setItem(tourKey(U, 'bad'), '{"status":"lol"}');
    expect(readTourRecord(U, 'bad')).toBeNull();
    window.localStorage.setItem(tourKey(U, 'broken'), '{not json');
    expect(readTourRecord(U, 'broken')).toBeNull();
  });

  it('requestTour 每次都是新的请求', () => {
    useTourStore.getState().requestTour();
    const first = useTourStore.getState().request;
    useTourStore.getState().requestTour('advisor');
    const second = useTourStore.getState().request;
    expect(second?.id).toBeGreaterThan(first?.id ?? 0);
    expect(second?.variant).toBe('advisor');
  });

  it('测试环境默认不自动开始，可以注入打开，也可以用 localStorage 关掉', () => {
    expect(autoStartEnabled()).toBe(false);
    configureOnboarding({ autoStart: true });
    expect(autoStartEnabled()).toBe(true);
    window.localStorage.setItem('srh-onboarding:off', '1');
    expect(autoStartEnabled()).toBe(false);
  });
});

describe('找目标元素', () => {
  const step: TourStep = {
    id: 'threads',
    icon: 'threads',
    title: '线程',
    body: '…',
    targets: [{ selector: 'nav a[href="/p/{pid}/threads"]' }],
    fallbacks: [{ selector: 'button[aria-label="打开导航"]' }],
  };

  function dom(html: string) {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
  }

  it('目标可见时直接高亮它，{pid} 会被替换', () => {
    const root = dom('<nav><a href="/p/prj_9/threads">线程</a></nav>');
    const res = resolveTarget(step, 'prj_9', { root, isVisible: () => true });
    expect(res.kind).toBe('target');
    expect(res.el?.textContent).toBe('线程');
  });

  it('目标看不见（手机上侧栏在抽屉里）时退到菜单按钮', () => {
    const root = dom(
      '<nav><a href="/p/prj_9/threads" data-hidden>线程</a></nav><button aria-label="打开导航">≡</button>',
    );
    const res = resolveTarget(step, 'prj_9', {
      root,
      isVisible: (el) => !el.hasAttribute('data-hidden'),
    });
    expect(res.kind).toBe('fallback');
    expect(res.el?.tagName).toBe('BUTTON');
  });

  it('都找不到时返回 none（居中卡片）', () => {
    const res = resolveTarget(step, 'prj_9', { root: dom('<p>空</p>'), isVisible: () => true });
    expect(res).toEqual({ el: null, kind: 'none' });
  });

  it('closest 高亮整张输入卡片', () => {
    const root = dom('<form id="f"><textarea placeholder="x"></textarea></form>');
    const res = resolveTarget(
      { ...step, targets: [{ selector: 'textarea', closest: 'form' }] },
      'p',
      { root, isVisible: () => true },
    );
    expect(res.el?.id).toBe('f');
  });
});

describe('卡片定位', () => {
  const viewport = { w: 1440, h: 900 };
  const card = { w: 340, h: 220 };

  it('侧栏项的卡片放在右侧并垂直居中对齐', () => {
    const hole = { x: 8, y: 200, w: 232, h: 44 };
    const p = placeCard(hole, card, viewport);
    expect(p.side).toBe('right');
    expect(p.x).toBe(8 + 232 + 14);
    expect(p.y).toBe(200 + 22 - 110);
  });

  it('右边放不下时放下方，再放不下放上方', () => {
    const topRight = { x: 1300, y: 10, w: 120, h: 32 };
    expect(placeCard(topRight, card, viewport).side).toBe('bottom');
    const bottomWide = { x: 300, y: 800, w: 1130, h: 80 };
    expect(placeCard(bottomWide, card, viewport).side).toBe('top');
  });

  it('没有目标时居中，结果不会超出视口', () => {
    expect(placeCard(null, card, viewport)).toEqual({ x: 550, y: 340, side: 'center' });
    const p = placeCard({ x: 1300, y: 10, w: 120, h: 32 }, card, viewport);
    expect(p.x + card.w).toBeLessThanOrEqual(viewport.w - 12);
  });

  it('高亮框外扩并夹在视口里', () => {
    expect(spotlightRect({ x: 0, y: 0, w: 100, h: 30 }, viewport)).toEqual({
      x: 4,
      y: 4,
      w: 102,
      h: 32,
    });
  });

  it('手机上目标在下半屏时卡片贴顶', () => {
    const phone = { w: 390, h: 844 };
    expect(sheetDock({ x: 12, y: 740, w: 366, h: 80 }, phone)).toBe('top');
    expect(sheetDock({ x: 8, y: 8, w: 36, h: 36 }, phone)).toBe('bottom');
    expect(sheetDock(null, phone)).toBe('bottom');
  });
});

describe('模块介绍', () => {
  it('只在模块首页出现', () => {
    expect(introForPath('/p/prj_1')?.label).toBe('协作台');
    expect(introForPath('/p/prj_1/docs')?.label).toBe('文档');
    expect(introForPath('/p/prj_1/reviews')?.anchor).toBe('reviews');
    expect(introForPath('/p/prj_1/docs/doc_1')).toBeNull();
    expect(introForPath('/p/prj_1/settings')).toBeNull();
    expect(introForPath('/p/prj_1/help')).toBeNull();
    expect(introForPath('/login')).toBeNull();
  });

  it('前几次展示，点过“不再显示”就不再出现', () => {
    expect(shouldShowIntro({ views: 0, dismissed: false })).toBe(true);
    expect(shouldShowIntro({ views: INTRO_MAX_VIEWS - 1, dismissed: false })).toBe(true);
    expect(shouldShowIntro({ views: INTRO_MAX_VIEWS, dismissed: false })).toBe(false);
    expect(shouldShowIntro({ views: 0, dismissed: true })).toBe(false);
    expect(introKey(U, '')).toBe('srh-intro:v1:usr_1:home');
    expect(readIntroRecord(U, 'docs')).toEqual({ views: 0, dismissed: false });
  });
});
