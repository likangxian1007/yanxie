import { Dialog, Kbd } from '@/components/ui';
import { tr } from '@/lib/i18n';

const COMMAND: [string, string][] = [
  ['Enter', tr('编辑选中的单元格')],
  ['Shift+Enter', tr('运行，选中下一个')],
  ['Ctrl+Enter', tr('运行')],
  ['Alt+Enter', tr('运行，并在下方插入')],
  ['↑ / K', tr('选上一个')],
  ['↓ / J', tr('选下一个')],
  ['Shift+↑ / ↓', tr('扩展选择')],
  ['A', tr('在上方插入')],
  ['B', tr('在下方插入')],
  ['X / C / V', tr('剪切 / 复制 / 粘贴到下方')],
  ['Shift+V', tr('粘贴到上方')],
  ['D, D', tr('删除')],
  ['Z', tr('撤销删除')],
  ['Y / M / R', tr('改成 代码 / Markdown / Raw')],
  ['1 – 6', tr('改成 1–6 级标题')],
  ['Shift+M', tr('合并选中的单元格')],
  ['L', tr('显示 / 隐藏行号')],
  ['O / Shift+O', tr('折叠输出 / 折叠代码')],
  ['I, I', tr('中断内核')],
  ['0, 0', tr('重启内核')],
  ['H', tr('显示这个帮助')],
];

const EDIT: [string, string][] = [
  ['Esc', tr('回到命令模式')],
  ['Shift+Enter', tr('运行，选中下一个')],
  ['Ctrl+Enter', tr('运行')],
  ['Alt+Enter', tr('运行，并在下方插入')],
  ['Tab', tr('补全（内核）/ 缩进')],
  ['Shift+Tab', tr('反缩进')],
  ['Ctrl+Shift+-', tr('在光标处拆分')],
  ['Ctrl+Z / Ctrl+Shift+Z', tr('撤销 / 重做（只撤销自己的修改）')],
];

function Table({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-body-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="whitespace-nowrap">
            {k.split(' / ').map((part, i) => (
              <span key={part}>
                {i > 0 && <span className="px-1 text-fg-subtle">/</span>}
                <Kbd>{part}</Kbd>
              </span>
            ))}
          </dt>
          <dd className="text-fg-muted">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={tr('键盘快捷键')}
      description={tr('和 JupyterLab 一样。命令模式下单元格左侧是蓝条，编辑模式下编辑器有光标。')}
    >
      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h3 className="mb-2 text-h3 text-fg">{tr('命令模式（按 Esc 进入）')}</h3>
          <Table rows={COMMAND} />
        </section>
        <section>
          <h3 className="mb-2 text-h3 text-fg">{tr('编辑模式（按 Enter 进入）')}</h3>
          <Table rows={EDIT} />
        </section>
      </div>
    </Dialog>
  );
}
