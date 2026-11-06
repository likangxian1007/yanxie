import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { assetsMap, filesMap, listProjectFiles, type ProjectFile } from './files';

/** 工程文件列表（随协作者新建 / 改名 / 删除实时更新） */
export function useProjectFiles(doc: Y.Doc): ProjectFile[] {
  const [files, setFiles] = useState<ProjectFile[]>(() => listProjectFiles(doc));
  useEffect(() => {
    const update = () => {
      setFiles((prev) => {
        const next = listProjectFiles(doc);
        const same =
          prev.length === next.length &&
          prev.every(
            (f, i) =>
              f.name === next[i]!.name &&
              f.kind === next[i]!.kind &&
              f.asset?.fileId === next[i]!.asset?.fileId,
          );
        return same ? prev : next;
      });
    };
    update();
    const fm = filesMap(doc);
    const am = assetsMap(doc);
    fm.observe(update);
    am.observe(update);
    return () => {
      fm.unobserve(update);
      am.unobserve(update);
    };
  }, [doc]);
  return files;
}
