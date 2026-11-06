import { useRef } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  Copy,
  Download,
  FastForward,
  History,
  Keyboard,
  ListTree,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Square,
  Upload,
} from 'lucide-react';
import type { NotebookCellType, NotebookExportFormat } from '@srh/shared';
import {
  AvatarStack,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Tooltip,
  toast,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { CollabPeer } from '@/features/docs/collab/useCollabDoc';
import { exportUrl } from '../api';
import type { KernelView } from '../model';
import { tr } from '@/lib/i18n';

type Control = 'interrupt' | 'restart' | 'restartRunAll' | 'restartClear' | 'shutdown';

interface Props {
  pid: string;
  notebookId: string;
  title: string;
  writable: boolean;
  kernel: KernelView;
  kernelAvailable: boolean;
  busy: boolean;
  currentType: NotebookCellType;
  peers: CollabPeer[];
  hasCells: boolean;
  lineNumbers: boolean;
  onInsert: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onMove: (delta: -1 | 1) => void;
  onRun: () => void;
  onRunAll: (range: 'all' | 'above' | 'below') => void;
  onControl: (what: Control) => void;
  onType: (t: NotebookCellType) => void;
  onClearOutputs: (all: boolean) => void;
  onToggleLineNumbers: () => void;
  onShowVariables: () => void;
  onShowHelp: () => void;
  /** 版本历史（存为版本、对比、回滚） */
  onShowHistory?: () => void;
  onImport: (ipynb: string) => Promise<unknown>;
}

const EXPORTS: { format: NotebookExportFormat; label: string; hint: string }[] = [
  { format: 'ipynb', label: 'Notebook (.ipynb)', hint: tr('Jupyter / Colab / VS Code 直接打开') },
  { format: 'html', label: 'HTML', hint: tr('带运行结果和图，浏览器打开') },
  { format: 'pdf', label: 'PDF', hint: tr('打印版，适合发给导师') },
  { format: 'md', label: 'Markdown', hint: tr('图片打包在 zip 里') },
  { format: 'py', label: tr('Python 脚本 (.py)'), hint: tr('Markdown 变成注释') },
  { format: 'zip', label: tr('全部打包 (.zip)'), hint: tr('以上所有格式 + 图片') },
];

const KERNEL_LABEL: Record<string, string> = {
  none: tr('未启动'),
  starting: tr('正在启动'),
  idle: tr('空闲'),
  busy: tr('运行中'),
  restarting: tr('正在重启'),
  dead: tr('已停止'),
  unavailable: tr('不可用'),
};

/** JupyterLab 式工具栏：菜单 + 图标按钮 + 单元格类型 + 内核状态 + 在线的人 */
export function NotebookToolbar(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const status = p.kernelAvailable ? (p.busy ? 'busy' : p.kernel.status) : 'unavailable';
  const can = p.writable;

  const download = (format: NotebookExportFormat) => {
    const a = document.createElement('a');
    a.href = exportUrl(p.pid, p.notebookId, format);
    a.rel = 'noopener';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (format === 'pdf') toast.success(tr('正在生成 PDF'), tr('图表多时需要几秒钟。'));
  };

  const importFile = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      toast.error(tr('文件太大'), tr('.ipynb 不能超过 50 MB。'));
      return;
    }
    try {
      await p.onImport(await file.text());
      toast.success(
        tr('已导入'),
        tr('{name} 替换了当前内容，所有人同步可见。', { name: file.name }),
      );
    } catch (err) {
      toast.error(
        tr('导入失败'),
        err instanceof ApiRequestError ? err.message : tr('文件不是有效的 .ipynb。'),
      );
    }
  };

  return (
    <div className="nb-toolbar sticky top-0 z-20 -mx-1 mb-3 flex flex-col gap-1 border-b border-line bg-canvas/90 px-1 pb-1.5 pt-1 backdrop-blur">
      {/* ---- 菜单栏（文件 / 编辑 / 运行 / 内核 / 视图） ---- */}
      <div className="flex items-center gap-0.5 text-[13px]">
        <Menu
          label={tr('文件')}
          trigger={
            <button type="button" className="nb-menu-btn">
              {tr('文件')}
            </button>
          }
        >
          <MenuLabel>{tr('下载（含运行结果）')}</MenuLabel>
          {EXPORTS.map((e) => (
            <MenuItem key={e.format} onSelect={() => download(e.format)} description={e.hint}>
              {e.label}
            </MenuItem>
          ))}
          {p.onShowHistory && (
            <>
              <MenuSeparator />
              <MenuItem icon={<History size={15} />} onSelect={p.onShowHistory}>
                {tr('版本历史…')}
              </MenuItem>
            </>
          )}
          {can && (
            <>
              <MenuSeparator />
              <MenuItem
                icon={<Upload size={15} />}
                onSelect={() => fileInput.current?.click()}
                description={tr('用 .ipynb 替换当前内容')}
              >
                {tr('导入 .ipynb…')}
              </MenuItem>
            </>
          )}
        </Menu>
        {can && (
          <Menu
            label={tr('编辑')}
            trigger={
              <button type="button" className="nb-menu-btn">
                {tr('编辑')}
              </button>
            }
          >
            <MenuItem shortcut="X" onSelect={p.onCut}>
              {tr('剪切单元格')}
            </MenuItem>
            <MenuItem shortcut="C" onSelect={p.onCopy}>
              {tr('复制单元格')}
            </MenuItem>
            <MenuItem shortcut="V" onSelect={p.onPaste}>
              {tr('粘贴到下方')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem shortcut="A / B" onSelect={p.onInsert}>
              {tr('插入单元格')}
            </MenuItem>
            <MenuItem onSelect={() => p.onMove(-1)}>{tr('上移')}</MenuItem>
            <MenuItem onSelect={() => p.onMove(1)}>{tr('下移')}</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => p.onClearOutputs(false)}>
              {tr('清除选中单元格的输出')}
            </MenuItem>
            <MenuItem onSelect={() => p.onClearOutputs(true)}>{tr('清除全部输出')}</MenuItem>
          </Menu>
        )}
        {can && (
          <Menu
            label={tr('运行')}
            trigger={
              <button type="button" className="nb-menu-btn">
                {tr('运行')}
              </button>
            }
          >
            <MenuItem shortcut="Shift+Enter" onSelect={p.onRun}>
              {tr('运行选中单元格')}
            </MenuItem>
            <MenuItem onSelect={() => p.onRunAll('above')}>{tr('运行上方全部')}</MenuItem>
            <MenuItem onSelect={() => p.onRunAll('below')}>{tr('运行选中及下方')}</MenuItem>
            <MenuItem onSelect={() => p.onRunAll('all')}>{tr('运行全部')}</MenuItem>
          </Menu>
        )}
        {can && (
          <Menu
            label={tr('内核')}
            trigger={
              <button type="button" className="nb-menu-btn">
                {tr('内核')}
              </button>
            }
          >
            <MenuItem shortcut="I, I" onSelect={() => p.onControl('interrupt')}>
              {tr('中断')}
            </MenuItem>
            <MenuItem shortcut="0, 0" onSelect={() => p.onControl('restart')}>
              {tr('重启内核')}
            </MenuItem>
            <MenuItem onSelect={() => p.onControl('restartClear')}>{tr('重启并清除输出')}</MenuItem>
            <MenuItem onSelect={() => p.onControl('restartRunAll')}>
              {tr('重启并运行全部')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={() => p.onControl('shutdown')}>
              {tr('关闭内核')}
            </MenuItem>
          </Menu>
        )}
        <Menu
          label={tr('视图')}
          trigger={
            <button type="button" className="nb-menu-btn">
              {tr('视图')}
            </button>
          }
        >
          <MenuItem checked={p.lineNumbers} shortcut="L" onSelect={p.onToggleLineNumbers}>
            {tr('显示行号')}
          </MenuItem>
          <MenuItem icon={<ListTree size={15} />} onSelect={p.onShowVariables}>
            {tr('变量查看器')}
          </MenuItem>
          <MenuItem icon={<Keyboard size={15} />} shortcut="H" onSelect={p.onShowHelp}>
            {tr('快捷键')}
          </MenuItem>
        </Menu>

        <div className="ml-auto flex items-center gap-2">
          {p.peers.length > 1 && (
            <AvatarStack
              size={20}
              max={4}
              label={tr('正在看这本 notebook 的人')}
              members={p.peers.map((x) => ({
                id: x.user.id,
                name: x.user.name,
                color: x.user.colorIndex,
                kind: x.user.kind,
                activity: x.isSelf
                  ? tr('你')
                  : x.state.mode === 'edit'
                    ? tr('正在编辑')
                    : tr('在看'),
              }))}
            />
          )}
          <KernelBadge status={status} count={p.kernel.executionCount} />
        </div>
      </div>

      {/* ---- 图标工具栏 ---- */}
      {can && (
        <div className="flex flex-wrap items-center gap-0.5">
          <IconButton
            label={tr('在下方插入单元格')}
            shortcut="B"
            size="sm"
            variant="ghost"
            onClick={p.onInsert}
          >
            <Plus size={16} />
          </IconButton>
          <IconButton label={tr('剪切')} shortcut="X" size="sm" variant="ghost" onClick={p.onCut}>
            <Scissors size={15} />
          </IconButton>
          <IconButton label={tr('复制')} shortcut="C" size="sm" variant="ghost" onClick={p.onCopy}>
            <Copy size={15} />
          </IconButton>
          <IconButton label={tr('粘贴')} shortcut="V" size="sm" variant="ghost" onClick={p.onPaste}>
            <ClipboardPaste size={15} />
          </IconButton>
          <IconButton label={tr('上移')} size="sm" variant="ghost" onClick={() => p.onMove(-1)}>
            <ArrowUp size={15} />
          </IconButton>
          <IconButton label={tr('下移')} size="sm" variant="ghost" onClick={() => p.onMove(1)}>
            <ArrowDown size={15} />
          </IconButton>
          <span className="mx-1 h-4 w-px bg-line" />
          <IconButton
            label={tr('运行')}
            shortcut="Shift+Enter"
            size="sm"
            variant="ghost"
            onClick={p.onRun}
          >
            <Play size={15} />
          </IconButton>
          <IconButton
            label={tr('中断内核')}
            shortcut="I, I"
            size="sm"
            variant="ghost"
            onClick={() => p.onControl('interrupt')}
          >
            <Square size={13} />
          </IconButton>
          <IconButton
            label={tr('重启内核')}
            shortcut="0, 0"
            size="sm"
            variant="ghost"
            onClick={() => p.onControl('restart')}
          >
            <RotateCcw size={15} />
          </IconButton>
          <IconButton
            label={tr('重启并运行全部')}
            size="sm"
            variant="ghost"
            onClick={() => p.onControl('restartRunAll')}
          >
            <FastForward size={15} />
          </IconButton>
          <select
            aria-label={tr('单元格类型')}
            className="nb-type-select ml-1"
            value={p.currentType}
            onChange={(e) => p.onType(e.target.value as NotebookCellType)}
          >
            <option value="code">Code</option>
            <option value="markdown">Markdown</option>
            <option value="raw">Raw</option>
          </select>
          <div className="ml-auto flex items-center gap-0.5">
            {p.onShowHistory && (
              <IconButton
                label={tr('版本历史')}
                size="sm"
                variant="ghost"
                onClick={p.onShowHistory}
              >
                <History size={15} />
              </IconButton>
            )}
            <Menu
              label={tr('下载')}
              align="end"
              trigger={
                <IconButton label={tr('下载')} size="sm" variant="ghost">
                  <Download size={15} />
                </IconButton>
              }
            >
              {EXPORTS.map((e) => (
                <MenuItem key={e.format} onSelect={() => download(e.format)} description={e.hint}>
                  {e.label}
                </MenuItem>
              ))}
            </Menu>
          </div>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        accept=".ipynb,application/x-ipynb+json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importFile(f);
        }}
      />
    </div>
  );
}

function KernelBadge({ status, count }: { status: string; count: number }) {
  const busy = status === 'busy' || status === 'starting' || status === 'restarting';
  return (
    <Tooltip
      content={count ? tr('Python 3 · 已执行 {count} 次', { count }) : 'Python 3 (ipykernel)'}
    >
      <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-caption text-fg-muted">
        Python 3
        <span
          aria-label={tr('内核{value}', { value: KERNEL_LABEL[status] ?? status })}
          className={cn(
            'inline-block size-2.5 rounded-full border',
            busy
              ? 'border-fg-muted bg-fg-muted'
              : status === 'dead' || status === 'unavailable'
                ? 'border-danger bg-transparent'
                : 'border-fg-muted bg-transparent',
          )}
        />
        <span className="hidden sm:inline">{KERNEL_LABEL[status] ?? status}</span>
      </span>
    </Tooltip>
  );
}
