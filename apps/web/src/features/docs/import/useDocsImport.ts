import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { DocumentMeta, ResourceSpace } from '@srh/shared';
import { toast } from '@/components/ui';
import { useImportQueue, type ImportItem } from './useImportQueue';
import { useFileDrop } from './useFileDrop';
import { tr } from '@/lib/i18n';

/**
 * 文档列表页的“上传文件”：共享的导入队列 + 对话框开关 + 拖放到列表上。
 * 一次只传一个文件且成功时，直接打开新文档（没能导入的部分用提示告诉用户）；
 * 多个文件时留在对话框里逐个看结果。
 */
export function useDocsImport(pid: string, enabled: boolean, space: ResourceSpace = 'team') {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const openAfter = useRef(new Set<string>());

  const onDone = (item: ImportItem & { meta: DocumentMeta }) => {
    if (!openAfter.current.delete(item.id)) return;
    if (item.warnings.length) {
      toast({
        title: tr('已导入，有部分内容没能导入'),
        description: item.warnings.join(tr('；')),
        tone: 'warning',
      });
    }
    setOpen(false);
    navigate(`/p/${pid}/docs/${item.meta.id}`);
  };
  // 两个空间各一条队列：在「我的空间」上传的文件进个人空间
  const queue = useImportQueue(`list:${pid}:${space}`, { pid, space }, onDone);

  const addFiles = (files: File[]) => {
    const added = queue.add(files);
    openAfter.current.clear();
    if (added.length === 1 && added[0]!.status === 'queued') openAfter.current.add(added[0]!.id);
    setOpen(true);
  };

  const drop = useFileDrop(addFiles, enabled);
  return { open, setOpen, queue, addFiles, drop };
}
