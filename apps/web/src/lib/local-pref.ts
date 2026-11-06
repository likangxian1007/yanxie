import { useCallback, useState } from 'react';

/**
 * 存在这台设备浏览器里的小偏好（视图模式、是否分组等）。读写失败时退回内存值。
 */
export function useLocalPref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // 忽略（隐私模式等）
      }
    },
    [key],
  );
  return [value, set];
}
