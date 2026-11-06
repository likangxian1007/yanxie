import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { DocumentKind, ResourceSpace } from '@srh/shared';
import { toast } from '@/components/ui';
import { templateDocTitle, UNTITLED_TITLE, type DocTemplate } from '../templates';
import { useCreateDoc } from './use-docs';
import { tr } from '@/lib/i18n';

/**
 * 新建文档并跳到详情页。`pending` 是正在新建的来源（类型或模板 id），
 * 用来在对应按钮上显示加载中。
 */
export function useCreateAndOpen(pid: string, space: ResourceSpace = 'team') {
  const create = useCreateDoc(pid);
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);

  const run = (key: string, input: { title: string; kind: DocumentKind; markdown?: string }) => {
    if (create.isPending) return;
    setPending(key);
    create.mutate(space === 'personal' ? { ...input, space } : input, {
      onSuccess: (doc) => navigate(`/p/${pid}/docs/${doc.id}`),
      onError: (err) => toast.error(tr('新建失败'), err.message),
      onSettled: () => setPending(null),
    });
  };

  return {
    pending,
    createBlank: (kind: DocumentKind) => run(kind, { title: UNTITLED_TITLE[kind], kind }),
    createFromTemplate: (t: DocTemplate) =>
      run(t.id, {
        title: templateDocTitle(t),
        kind: t.kind,
        ...(t.markdown ? { markdown: t.markdown } : {}),
      }),
  };
}
