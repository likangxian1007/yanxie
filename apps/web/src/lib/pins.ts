import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MyPins } from '@srh/shared';
import { toast } from '@/components/ui/toast-store';
import { api, ApiRequestError } from './api';
import { tr } from '@/lib/i18n';

/**
 * 置顶线程：存在服务端，跟账号走（GET /auth/me/pins、PUT /auth/me/pins/:projectId），
 * 换设备、换浏览器、清缓存都还在。每个项目一组 id，越靠前越新，最多 MAX_PINS 个。
 *
 * 以前只存在本机 localStorage['srh-pins']：第一次拉取时把本机的合并进服务端，成功后清掉本机这份。
 * 对外的用法不变：usePins(projectId) 读、usePinStore((s) => s.toggle) 切换。
 */
export const LEGACY_PINS_KEY = 'srh-pins';
export const PINS_QUERY_KEY = ['me', 'pins'] as const;
export const MAX_PINS = 12;

/** 只留下「项目 id → 字符串数组」，其他一律丢掉 */
export function sanitizePins(raw: unknown): MyPins {
  const out: MyPins = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [pid, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    const clean = ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (clean.length) out[pid] = [...new Set(clean)];
  }
  return out;
}

/** 服务端的在前（一个不丢、顺序不变），本机多出来的接在后面，总数到 MAX_PINS 为止 */
export function mergePins(server: readonly string[], local: readonly string[]): string[] {
  const extra = local.filter((id, i) => !server.includes(id) && local.indexOf(id) === i);
  return [...server, ...extra.slice(0, Math.max(0, MAX_PINS - server.length))];
}

/** 置顶 / 取消置顶：新置顶的放最前 */
export function togglePinList(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [id, ...list].slice(0, MAX_PINS);
}

function readLegacy(): MyPins | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_PINS_KEY);
    return raw === null ? null : sanitizePins(JSON.parse(raw));
  } catch {
    return null;
  }
}

function clearLegacy() {
  try {
    window.localStorage.removeItem(LEGACY_PINS_KEY);
  } catch {
    // 忽略
  }
}

const putPins = (projectId: string, ids: string[]) =>
  api.put<{ projectId: string; ids: string[] }>(`/auth/me/pins/${projectId}`, { ids });

/** 拉取我的置顶；本机还有旧的 localStorage 置顶时合并上去（只做一次，成功后清掉本机） */
export async function fetchPins(signal?: AbortSignal): Promise<MyPins> {
  const server = sanitizePins(await api.get<unknown>('/auth/me/pins', signal ? { signal } : {}));
  const legacy = typeof window === 'undefined' ? null : readLegacy();
  if (!legacy) return server;
  let retryLater = false;
  for (const [pid, local] of Object.entries(legacy)) {
    const current = server[pid] ?? [];
    const merged = mergePins(current, local);
    if (merged.length === current.length) continue;
    try {
      server[pid] = (await putPins(pid, merged)).ids;
    } catch (e) {
      // 不再是成员 / 项目没了：这份本机置顶没用了；其他错误（断网等）下次再试
      const gone = e instanceof ApiRequestError && (e.status === 404 || e.status === 403);
      if (!gone) retryLater = true;
    }
  }
  if (!retryLater) clearLegacy();
  return server;
}

const EMPTY: string[] = [];

function usePinsQuery() {
  return useQuery<MyPins>({
    queryKey: PINS_QUERY_KEY,
    queryFn: ({ signal }) => fetchPins(signal),
    staleTime: 30_000,
    // 还没拉到时先显示本机旧的置顶，避免侧栏闪一下
    placeholderData: (): MyPins | undefined =>
      typeof window === 'undefined' ? undefined : (readLegacy() ?? undefined),
  });
}

export function usePins(projectId: string): string[] {
  const { data } = usePinsQuery();
  return data?.[projectId] ?? EMPTY;
}

interface PinState {
  pins: MyPins;
  toggle: (projectId: string, threadId: string) => void;
}

/** 乐观更新：先改缓存再 PUT 整组，失败回滚并提示 */
function useTogglePin() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ projectId, ids }: { projectId: string; ids: string[] }) =>
      putPins(projectId, ids),
    onMutate: async ({ projectId, ids }) => {
      await qc.cancelQueries({ queryKey: PINS_QUERY_KEY });
      const previous = qc.getQueryData<MyPins>(PINS_QUERY_KEY);
      qc.setQueryData<MyPins>(PINS_QUERY_KEY, (d) => ({ ...d, [projectId]: ids }));
      return { previous };
    },
    onError: (e, _vars, ctx) => {
      qc.setQueryData(PINS_QUERY_KEY, ctx?.previous);
      toast({
        tone: 'danger',
        title: tr('置顶没保存'),
        description: tr('{message} 稍后再试一次。', { message: e.message }),
      });
      void qc.invalidateQueries({ queryKey: PINS_QUERY_KEY });
    },
  });
  const { mutate } = mutation;
  return useCallback(
    (projectId: string, threadId: string) => {
      // 还没拉到服务端的置顶时先拉（否则会用空列表覆盖掉已有的置顶）
      void qc
        .ensureQueryData({ queryKey: PINS_QUERY_KEY, queryFn: ({ signal }) => fetchPins(signal) })
        .catch(() => qc.getQueryData<MyPins>(PINS_QUERY_KEY) ?? {})
        .then((pins) => {
          const current = qc.getQueryData<MyPins>(PINS_QUERY_KEY)?.[projectId] ?? pins[projectId];
          mutate({ projectId, ids: togglePinList(current ?? EMPTY, threadId) });
        });
    },
    [qc, mutate],
  );
}

/** 置顶状态 + 切换；用法和原来的 zustand store 一样：usePinStore((s) => s.toggle) */
export function usePinStore<T>(selector: (s: PinState) => T): T {
  const { data } = usePinsQuery();
  const toggle = useTogglePin();
  return selector({ pins: data ?? {}, toggle });
}
