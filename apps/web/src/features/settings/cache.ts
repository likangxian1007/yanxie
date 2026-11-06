import type { QueryClient } from '@tanstack/react-query';
import type { MemoryFile } from '@srh/shared';
import { qk } from '@/lib/query-keys';
import type { MemoryMeta } from './queries';

/** 写入记忆后同步两份缓存（与 lib/apply-event.ts 的 memory.updated 处理一致）。 */
export function upsertMemoryCaches(qc: QueryClient, pid: string, file: MemoryFile) {
  const { content: _content, ...meta } = file;
  qc.setQueryData(qk.memoryFile(pid, file.path), file);
  qc.setQueryData<MemoryMeta[]>(qk.memory(pid), (list) => {
    if (!list) return list;
    const rest = list.filter((x) => x.path !== file.path);
    return [...rest, meta].sort((a, b) => a.path.localeCompare(b.path));
  });
}

export function removeMemoryCaches(qc: QueryClient, pid: string, path: string) {
  qc.setQueryData<MemoryMeta[]>(qk.memory(pid), (list) => list?.filter((x) => x.path !== path));
  qc.removeQueries({ queryKey: qk.memoryFile(pid, path), exact: true });
}
