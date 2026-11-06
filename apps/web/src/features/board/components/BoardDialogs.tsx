import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import type { BoardColumn } from '@srh/shared';
import { Button, Dialog, Input, Select } from '@/components/ui';
import { cn } from '@/lib/cn';
import { PALETTE_NAMES, PALETTE_SIZE, paletteVar } from '@/lib/palette';
import type { BoardActions } from '../data';
import { COLUMN_WIDTH } from './BoardColumnView';
import { tr, trServer } from '@/lib/i18n';

export interface BoardNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'rename';
  initialName?: string;
  onSubmit: (name: string) => Promise<boolean>;
}

/** 新建 / 重命名看板 */
export function BoardNameDialog({ open, onOpenChange, ...rest }: BoardNameDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={rest.mode === 'create' ? tr('新建看板') : tr('重命名看板')}
      description={
        rest.mode === 'create'
          ? tr('新看板默认有“想法 / 进行中 / 待审阅 / 完成”四列，之后可以随时增删。')
          : undefined
      }
    >
      {open && <BoardNameForm onCancel={() => onOpenChange(false)} {...rest} />}
    </Dialog>
  );
}

function BoardNameForm({
  mode,
  initialName = '',
  onSubmit,
  onCancel,
}: Omit<BoardNameDialogProps, 'open' | 'onOpenChange'> & { onCancel: () => void }) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError(tr('请填写看板名称'));
      return;
    }
    setBusy(true);
    const ok = await onSubmit(n.slice(0, 60));
    setBusy(false);
    if (ok) onCancel();
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Input
        value={name}
        maxLength={60}
        placeholder={tr('例如：论文投稿、消融实验')}
        aria-label={tr('看板名称')}
        error={error}
        onChange={(e) => {
          setName(e.target.value);
          setError(undefined);
        }}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {tr('取消')}
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          {mode === 'create' ? tr('新建看板') : tr('保存名称')}
        </Button>
      </div>
    </form>
  );
}

export interface DeleteColumnDialogProps {
  column: BoardColumn | null;
  /** 该列卡片数 */
  cardCount: number;
  otherColumns: BoardColumn[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (moveTo: string | null) => Promise<boolean>;
}

/** 删除列：非空时先选把卡片移到哪一列（DELETE ?moveTo=） */
export function DeleteColumnDialog({
  column,
  cardCount,
  otherColumns,
  onOpenChange,
  onConfirm,
}: DeleteColumnDialogProps) {
  return (
    <Dialog
      open={column !== null}
      onOpenChange={onOpenChange}
      title={column ? tr('删除列「{name}」', { name: trServer(column.name) }) : tr('删除列')}
      description={
        cardCount > 0
          ? tr('这一列还有 {cardCount} 张卡片，删除前先把它们移到另一列。', { cardCount })
          : tr('这一列是空的，删除后不能恢复。')
      }
    >
      {column && (
        <DeleteColumnForm
          key={column.id}
          cardCount={cardCount}
          otherColumns={otherColumns}
          onCancel={() => onOpenChange(false)}
          onConfirm={onConfirm}
        />
      )}
    </Dialog>
  );
}

function DeleteColumnForm({
  cardCount,
  otherColumns,
  onCancel,
  onConfirm,
}: {
  cardCount: number;
  otherColumns: BoardColumn[];
  onCancel: () => void;
  onConfirm: (moveTo: string | null) => Promise<boolean>;
}) {
  const [moveTo, setMoveTo] = useState(otherColumns[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const needsTarget = cardCount > 0;

  const confirm = async () => {
    setBusy(true);
    const ok = await onConfirm(needsTarget ? moveTo || null : null);
    setBusy(false);
    if (ok) onCancel();
  };

  return (
    <div className="flex flex-col gap-4">
      {needsTarget && (
        <label className="flex flex-col gap-1.5">
          <span className="text-small text-fg-muted">{tr('把卡片移到')}</span>
          <Select
            value={moveTo}
            onChange={(e) => setMoveTo(e.target.value)}
            options={otherColumns.map((c) => ({ value: c.id, label: trServer(c.name) }))}
          />
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {tr('取消')}
        </Button>
        <Button
          variant="danger"
          loading={busy}
          disabled={needsTarget && !moveTo}
          onClick={() => void confirm()}
        >
          {needsTarget ? tr('移动并删除') : tr('删除列')}
        </Button>
      </div>
    </div>
  );
}

/** 列尾“添加列”：内联输入名称，回车添加 */
export function AddColumn({ actions, nextColor }: { actions: BoardActions; nextColor: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<number | null>(null);
  const effectiveColor = color ?? nextColor;

  const submit = () => {
    const n = name.trim().slice(0, 30);
    if (!n) return;
    void actions.createColumn(n, effectiveColor);
    setName('');
    setColor(null);
    setOpen(false);
  };

  return (
    <div className={cn('shrink-0 snap-start', COLUMN_WIDTH)}>
      {open ? (
        <div className="rounded-lg border border-line bg-subtle/70 p-2">
          <Input
            size="sm"
            autoFocus
            value={name}
            maxLength={30}
            placeholder={tr('列名，例如：已投稿')}
            aria-label={tr('新列名称')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <div role="radiogroup" aria-label={tr('列颜色')} className="mt-2 flex flex-wrap gap-1.5">
            {Array.from({ length: PALETTE_SIZE }, (_, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={effectiveColor === i}
                aria-label={PALETTE_NAMES[i]}
                onClick={() => setColor(i)}
                style={{ backgroundColor: paletteVar(i) }}
                className={cn(
                  'size-5 cursor-pointer rounded-full ring-offset-2 ring-offset-subtle transition-shadow duration-(--dur-fast)',
                  effectiveColor === i && 'ring-2 ring-fg-muted',
                )}
              />
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" onClick={submit} disabled={!name.trim()}>
              {tr('添加列')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {tr('取消')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          fullWidth
          className="h-11 justify-start border border-dashed border-line-strong/80"
          leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
          onClick={() => setOpen(true)}
        >
          {tr('添加列')}
        </Button>
      )}
    </div>
  );
}
