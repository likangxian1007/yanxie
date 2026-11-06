import { useEffect, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '@/lib/api';
import { FieldSync, type FieldSyncOptions } from './field-sync';

/**
 * 每个对象一个 FieldSync，按 QueryClient 分开登记：离开页面或关掉卡片详情时草稿和冲突都还在，
 * 回来能接着处理（不会因为组件卸载丢输入）。
 */
const registry = new WeakMap<QueryClient, Map<string, FieldSync<{ version: number }>>>();

export function getFieldSync<T extends { version: number }>(
  qc: QueryClient,
  key: string,
  create: () => FieldSyncOptions<T>,
): FieldSync<T> {
  let map = registry.get(qc);
  if (!map) {
    map = new Map();
    registry.set(qc, map);
  }
  let sync = map.get(key) as FieldSync<T> | undefined;
  if (!sync) {
    sync = new FieldSync<T>(create());
    map.set(key, sync as unknown as FieldSync<{ version: number }>);
  }
  return sync;
}

/** 已登记的 FieldSync（没有就 undefined，不创建） */
export function peekFieldSync<T extends { version: number }>(
  qc: QueryClient,
  key: string,
): FieldSync<T> | undefined {
  return registry.get(qc)?.get(key) as FieldSync<T> | undefined;
}

/** 从 ApiRequestError 里取 409 version_conflict 的 details.current */
export function versionConflictCurrent<T extends { id: string; version: number }>(
  id: string,
): (err: unknown) => T | null {
  return (err) => {
    if (!(err instanceof ApiRequestError) || err.code !== 'version_conflict') return null;
    const current = err.details?.['current'] as T | undefined;
    return current && typeof current === 'object' && current.id === id ? current : null;
  };
}

/** 订阅 FieldSync 的变化；server 变了（实时事件、重新拉取）时让它整理一下草稿基线 */
export function useFieldSync<T extends { version: number }>(
  sync: FieldSync<T> | undefined,
  server: T | undefined,
) {
  useSyncExternalStore(
    sync?.subscribe ?? noopSubscribe,
    sync?.getRevision ?? zero,
    sync?.getRevision ?? zero,
  );
  useEffect(() => {
    if (sync && server) sync.refresh(server);
  }, [sync, server]);
}

const noopSubscribe = () => () => undefined;
const zero = () => 0;

/** 有没保存的改动或未处理的冲突时，关页面 / 刷新前让浏览器提醒 */
export function useWarnBeforeUnload(when: boolean) {
  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [when]);
}
