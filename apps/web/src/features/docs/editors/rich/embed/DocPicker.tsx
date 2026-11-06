import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { DOCUMENT_KIND_LABEL, type DocumentKind, type DocumentMeta } from '@srh/shared';
import { Button, Dialog, Input, RelativeTime, Spinner, Tabs, toast } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { DocKindIcon } from '../../../kinds';
import { useCreateDoc, useDocs } from '../../../list/use-docs';
import { ICON_STROKE } from '../components/icons';
import { tr } from '@/lib/i18n';

export type EmbedKind = Extract<DocumentKind, 'sheet' | 'slides' | 'doc' | 'latex'>;

export interface DocPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** 当前文档（不能嵌入自己） */
  docId: string;
  kind: EmbedKind;
  /** true = 打开后直接聚焦“新建并嵌入” */
  createFirst?: boolean;
  onPick: (doc: DocumentMeta) => void;
}

const TAB_KINDS: EmbedKind[] = ['sheet', 'slides', 'doc', 'latex'];
const NEW_TITLE: Record<EmbedKind, string> = {
  sheet: tr('未命名表格'),
  slides: tr('未命名幻灯片'),
  doc: tr('未命名文档'),
  latex: tr('未命名论文'),
};

/** 过滤可嵌入的文档：同类型、未归档、不是自己；按关键词匹配标题（纯函数，测试用） */
export function embeddableDocs(
  docs: readonly DocumentMeta[],
  kind: EmbedKind,
  selfId: string,
  query: string,
): DocumentMeta[] {
  const q = query.trim().toLowerCase();
  return docs
    .filter((d) => d.kind === kind && d.id !== selfId && !d.archivedAt)
    .filter((d) => !q || d.title.toLowerCase().includes(q));
}

/** 选择要嵌入的文档，或新建一个再嵌入。 */
export function DocPicker(props: DocPickerProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={tr('嵌入文档')} size="md">
      {open && <PickerBody key={`${props.kind}:${String(props.createFirst)}`} {...props} />}
    </Dialog>
  );
}

function PickerBody({
  projectId,
  docId,
  kind: initialKind,
  createFirst,
  onPick,
  onOpenChange,
}: DocPickerProps) {
  const [kind, setKind] = useState<EmbedKind>(initialKind);
  const [query, setQuery] = useState('');
  const [newTitle, setNewTitle] = useState(NEW_TITLE[initialKind]);
  const docs = useDocs(projectId);
  const create = useCreateDoc(projectId);
  const list = useMemo(
    () => embeddableDocs(docs.data ?? [], kind, docId, query),
    [docs.data, kind, docId, query],
  );

  const pick = (d: DocumentMeta) => {
    onPick(d);
    onOpenChange(false);
  };

  const createAndPick = () => {
    create.mutate(
      { kind, title: newTitle.trim() || NEW_TITLE[kind] },
      {
        onSuccess: (d) => pick(d),
        onError: (err) =>
          toast({
            title: err instanceof ApiRequestError ? err.message : tr('没有建成，请稍后再试'),
            tone: 'danger',
          }),
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        aria-label={tr('文档类型')}
        variant="segmented"
        size="sm"
        layoutId="embed-kind"
        value={kind}
        onValueChange={(k) => {
          setKind(k);
          setNewTitle(NEW_TITLE[k]);
        }}
        items={TAB_KINDS.map((k) => ({ value: k, label: DOCUMENT_KIND_LABEL[k] }))}
      />
      <form
        className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong p-2"
        onSubmit={(e) => {
          e.preventDefault();
          createAndPick();
        }}
      >
        <DocKindIcon kind={kind} size="md" />
        <Input
          aria-label={tr('新{value}的名字', { value: DOCUMENT_KIND_LABEL[kind] })}
          size="sm"
          autoFocus={createFirst}
          value={newTitle}
          maxLength={200}
          onChange={(e) => setNewTitle(e.target.value)}
          wrapperClassName="min-w-0 flex-1"
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={create.isPending}
          leftIcon={
            create.isPending ? (
              <Spinner size={14} />
            ) : (
              <Plus strokeWidth={ICON_STROKE} aria-hidden />
            )
          }
        >
          {tr('新建{value}并嵌入', { value: DOCUMENT_KIND_LABEL[kind] })}
        </Button>
      </form>
      <Input
        aria-label={tr('搜索文档')}
        size="sm"
        autoFocus={!createFirst}
        leading={<Search size={14} strokeWidth={ICON_STROKE} aria-hidden />}
        placeholder={tr('搜索项目里的{value}', { value: DOCUMENT_KIND_LABEL[kind] })}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div
        role="listbox"
        aria-label={tr('可以嵌入的文档')}
        className="-mx-1 max-h-72 overflow-y-auto"
      >
        {docs.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner size={16} />
          </div>
        ) : list.length === 0 ? (
          <p className="px-2 py-6 text-center text-small text-fg-subtle">
            {query
              ? tr('没有找到匹配的文档')
              : tr('项目里还没有别的{value}，可以先新建一个', { value: DOCUMENT_KIND_LABEL[kind] })}
          </p>
        ) : (
          list.map((d) => (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => pick(d)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left',
                'transition-colors duration-(--dur-fast) hover:bg-subtle focus-visible:bg-subtle',
              )}
            >
              <DocKindIcon kind={d.kind} size="sm" />
              <span className="min-w-0 flex-1 truncate text-body text-fg">{d.title}</span>
              <RelativeTime iso={d.updatedAt} className="shrink-0 text-caption text-fg-subtle" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}
