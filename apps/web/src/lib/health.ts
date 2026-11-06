import { useQuery } from '@tanstack/react-query';
import { getHealth } from './api';
import { queryKeys } from './query';

export const HEALTH_REFETCH_MS = 30_000;

/** 服务状态：侧栏底部的状态点用它，每 30 秒刷新一次。 */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => getHealth(signal),
    refetchInterval: HEALTH_REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    retry: 1,
  });
}

export const DB_DRIVER_LABEL = {
  pglite: 'PGlite',
  postgres: 'Postgres',
} as const;
