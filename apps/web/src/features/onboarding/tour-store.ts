import { create } from 'zustand';
import { writeTourRecord, type TourVariant } from './storage';
import { clampStep, stepsFor } from './tour-steps';

/**
 * 引导的运行状态。外壳里的 OnboardingHost 负责自动开始；
 * 帮助中心、命令面板只调用 `requestTour()`，由 Host 按当前角色挑版本再开始。
 */

export interface ActiveTour {
  userId: string;
  projectId: string;
  variant: TourVariant;
  step: number;
}

/** 别处发来的“重看引导”请求（不带版本时按角色选） */
export interface TourRequest {
  variant?: TourVariant;
  /** 递增，保证连续两次请求都能被 Host 看到 */
  id: number;
}

interface TourState {
  active: ActiveTour | null;
  welcomeOpen: boolean;
  request: TourRequest | null;
  start: (tour: Omit<ActiveTour, 'step'> & { step?: number }) => void;
  next: () => void;
  prev: () => void;
  goTo: (step: number) => void;
  /** 跳过（记为 skipped） */
  skip: () => void;
  /** 走完最后一步（记为 done） */
  finish: () => void;
  /** 不记录地关掉（切换课题、退出登录） */
  close: () => void;
  setWelcomeOpen: (open: boolean) => void;
  requestTour: (variant?: TourVariant) => void;
  clearRequest: () => void;
}

let requestSeq = 0;

function persist(tour: ActiveTour, status: 'active' | 'done' | 'skipped') {
  writeTourRecord(tour.userId, tour.projectId, {
    status,
    step: tour.step,
    variant: tour.variant,
    welcomed: true,
  });
}

export const useTourStore = create<TourState>()((set, get) => ({
  active: null,
  welcomeOpen: false,
  request: null,
  start: ({ step = 0, ...rest }) => {
    const tour: ActiveTour = { ...rest, step: clampStep(rest.variant, step) };
    persist(tour, 'active');
    set({ active: tour, welcomeOpen: false });
  },
  next: () => {
    const tour = get().active;
    if (!tour) return;
    if (tour.step >= stepsFor(tour.variant).length - 1) {
      get().finish();
      return;
    }
    get().goTo(tour.step + 1);
  },
  prev: () => {
    const tour = get().active;
    if (!tour || tour.step === 0) return;
    get().goTo(tour.step - 1);
  },
  goTo: (step) => {
    const tour = get().active;
    if (!tour) return;
    const nextTour = { ...tour, step: clampStep(tour.variant, step) };
    persist(nextTour, 'active');
    set({ active: nextTour });
  },
  skip: () => {
    const tour = get().active;
    if (tour) persist(tour, 'skipped');
    set({ active: null });
  },
  finish: () => {
    const tour = get().active;
    if (tour) persist(tour, 'done');
    set({ active: null });
  },
  close: () => set({ active: null, welcomeOpen: false }),
  setWelcomeOpen: (welcomeOpen) => set({ welcomeOpen }),
  requestTour: (variant) => {
    requestSeq += 1;
    set({ request: { id: requestSeq, ...(variant ? { variant } : {}) } });
  },
  clearRequest: () => set({ request: null }),
}));
