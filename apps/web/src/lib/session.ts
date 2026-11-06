import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Project, ProjectRole, User } from '@srh/shared';
import { api, ApiRequestError } from './api';
import { qk } from './query-keys';
import { realtime } from './ws';

export type MyProject = Project & {
  role: ProjectRole;
  unread?: number;
  /** /auth/me 读取时该项目最新的事件 seq（/ws 订阅的补发下界） */
  eventSeq?: number;
};

export interface MeResponse {
  user: User;
  projects: MyProject[];
}

/** 当前用户与我加入的项目（GET /auth/me）。未登录时 error.status === 401。 */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => api.get<MeResponse>('/auth/me', { signal }),
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiRequestError && err.status < 500) && count < 2,
  });
}

/** 已登录用户（只能在 RequireAuth 之内用）。 */
export function useMeUser(): User | null {
  return useMe().data?.user ?? null;
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 401;
}

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSettled: () => {
      realtime.disconnect();
      qc.clear();
      navigate('/login', { replace: true });
    },
  });
}

/** 登录后去哪：?next= 里的站内路径，否则首页（首页会跳到上次的项目）。 */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

const LAST_PROJECT_KEY = 'srh-last-project';

export function rememberProject(projectId: string) {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // 忽略
  }
}

export function lastProject(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}
