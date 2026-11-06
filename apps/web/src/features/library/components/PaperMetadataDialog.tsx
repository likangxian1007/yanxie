import { useState } from 'react';
import type { Paper, PaperUpdateWithVersionsInput } from '@srh/shared';
import { Button, Dialog, Input, toast } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { useUpdatePaper } from '../api';
import type { LibraryScope } from '../lib/scope';
import { tr } from '@/lib/i18n';

export function PaperMetadataDialog({
  scope,
  paper,
  onClose,
}: {
  scope: LibraryScope;
  paper: Paper;
  onClose: () => void;
}) {
  // 打开时保存基线；实时事件只更新背景数据，不覆盖正在输入的草稿。
  const [baseline, setBaseline] = useState(paper);
  const [title, setTitle] = useState(paper.title);
  const [tags, setTags] = useState(paper.tags.join(', '));
  const update = useUpdatePaper(scope, paper.id);
  const [current, setCurrent] = useState<Paper | null>(null);
  const parsedTags = [
    ...new Set(
      tags
        .split(/[,，]/u)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const titleChanged = title.trim() !== baseline.title;
  const tagsChanged = JSON.stringify(parsedTags) !== JSON.stringify(baseline.tags);
  const invalid =
    !title.trim() ||
    title.trim().length > 500 ||
    parsedTags.length > 20 ||
    parsedTags.some((t) => t.length > 40);
  const save = () => {
    const patch: PaperUpdateWithVersionsInput = {};
    if (titleChanged) {
      patch.title = title.trim();
      patch.baseTitleVersion = baseline.titleVersion ?? 1;
    }
    if (tagsChanged) {
      patch.tags = parsedTags;
      patch.baseTagsVersion = baseline.tagsVersion ?? 1;
    }
    update.mutate(patch, {
      onSuccess: () => {
        toast({ tone: 'success', title: tr('论文信息已保存') });
        onClose();
      },
      onError: (error) => {
        if (error instanceof ApiRequestError && error.code === 'version_conflict') {
          setCurrent((error.details?.current as Paper | undefined) ?? null);
        }
      },
    });
  };
  return (
    <Dialog
      open
      title={tr('编辑论文信息')}
      size="md"
      onOpenChange={(open) => {
        if (!open && !update.isPending) onClose();
      }}
      description={tr('只保存你修改的字段。其他成员同时修改同一字段时，会提示核对。')}
      footer={
        <>
          <Button variant="ghost" disabled={update.isPending} onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={invalid || (!titleChanged && !tagsChanged) || Boolean(current)}
            onClick={save}
          >
            {tr('保存')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block space-y-1 text-small">
          {tr('标题')}
          <Input
            aria-label={tr('论文标题')}
            value={title}
            maxLength={500}
            disabled={update.isPending}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-small">
          {tr('标签')}
          <Input
            aria-label={tr('论文标签')}
            value={tags}
            disabled={update.isPending}
            onChange={(e) => setTags(e.target.value)}
          />
          <span className="text-caption text-fg-muted">
            {tr('用逗号分隔，最多 20 个，每个不超过 40 字。')}
          </span>
        </label>
        {update.error && (
          <p role="alert" className="text-small text-danger">
            {update.error.message}
          </p>
        )}
        {current && (
          <div className="rounded-md border border-line bg-subtle p-3 text-small space-y-2">
            <p>{tr('你的输入仍保留在上方。服务器最新内容：')}</p>
            <p className="wrap-anywhere">{tr('标题：{title}', { title: current.title })}</p>
            <p className="wrap-anywhere">
              {tr('标签：')}
              {current.tags.join(tr('、')) || tr('无')}
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                setBaseline(current);
                setTitle(current.title);
                setTags(current.tags.join(', '));
                setCurrent(null);
                update.reset();
              }}
            >
              {tr('载入最新版本')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
