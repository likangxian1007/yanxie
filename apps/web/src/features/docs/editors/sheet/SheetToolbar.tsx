import type { ReactNode } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownAZ,
  ArrowUpAZ,
  BarChart3,
  Bold,
  Download,
  FileSpreadsheet,
  FileText,
  FileUp,
  Filter,
  Grid2x2,
  Italic,
  Merge,
  PaintBucket,
  Printer,
  Redo2,
  Search,
  Snowflake,
  Square,
  SquareDashed,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  WrapText,
} from 'lucide-react';
import {
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Select,
  Separator,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { FORMAT_PRESETS, presetOf } from './engine/format';
import type { CellStyle } from './model/schema';
import { CELL_PALETTE } from './render/palette';
import { tr } from '@/lib/i18n';

export type BorderMode = 'all' | 'outer' | 'inner' | 'none' | 'top' | 'bottom' | 'left' | 'right';
export type FreezeMode = 'row' | 'col' | 'here' | 'none';

export interface SheetToolbarProps {
  editable: boolean;
  mk: string;
  style: CellStyle;
  merged: boolean;
  frozen: { rows: number; cols: number };
  filterOn: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onStyle: (patch: Partial<CellStyle>) => void;
  onNumFmt: (code: string | undefined) => void;
  onDecimals: (delta: 1 | -1) => void;
  onBorders: (mode: BorderMode) => void;
  onMerge: () => void;
  onFreeze: (mode: FreezeMode) => void;
  onSort: (asc: boolean) => void;
  onToggleFilter: () => void;
  onFind: () => void;
  onChart: () => void;
  onImport: () => void;
  onExportXlsx: () => void;
  onExportCsv: () => void;
  onExportPdf: () => void;
  ai: ReactNode;
}

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];

function Sep() {
  return <Separator orientation="vertical" className="mx-1 h-5 shrink-0 self-center" />;
}

function ColorMenu({
  label,
  icon,
  value,
  clearLabel,
  onPick,
}: {
  label: string;
  icon: ReactNode;
  value: string | undefined;
  clearLabel: string;
  onPick: (c: string | undefined) => void;
}) {
  return (
    <Menu
      label={label}
      trigger={
        <IconButton label={label} size="sm">
          <span className="relative flex flex-col items-center">
            {icon}
            <span
              aria-hidden
              className="absolute -bottom-1 h-0.5 w-4 rounded-full"
              style={{
                backgroundColor: value ?? 'transparent',
                outline: value ? undefined : '1px solid var(--color-line-strong)',
              }}
            />
          </span>
        </IconButton>
      }
    >
      <MenuItem onSelect={() => onPick(undefined)}>{clearLabel}</MenuItem>
      <MenuSeparator />
      <div role="group" aria-label={label} className="grid grid-cols-8 gap-1 p-2">
        {CELL_PALETTE.flat().map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            title={c}
            onClick={() => onPick(c)}
            className={cn(
              'size-5 rounded-xs border border-line transition-transform duration-(--dur-fast) hover:scale-110 motion-reduce:transition-none',
              value === c && 'ring-2 ring-accent ring-offset-1',
            )}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
    </Menu>
  );
}

export function SheetToolbar(p: SheetToolbarProps) {
  const st = p.style;
  const preset = presetOf(st.nf);
  const fmtOptions = FORMAT_PRESETS.map((f) => ({ value: f.id, label: f.label }));
  if (!preset) fmtOptions.push({ value: 'custom', label: tr('自定义') });
  const toggle = (key: 'b' | 'i' | 'u' | 's' | 'wrap') =>
    p.onStyle({ [key]: st[key] ? undefined : true });
  const ha = st.ha;
  return (
    <div
      role="toolbar"
      aria-label={tr('表格工具栏')}
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-canvas px-2 py-1 [scrollbar-width:none]"
    >
      {p.editable && (
        <>
          <IconButton
            label={tr('撤销')}
            shortcut={`${p.mk}Z`}
            size="sm"
            disabled={!p.canUndo}
            onClick={p.onUndo}
          >
            <Undo2 strokeWidth={1.75} aria-hidden />
          </IconButton>
          <IconButton
            label={tr('重做')}
            shortcut={`${p.mk}Y`}
            size="sm"
            disabled={!p.canRedo}
            onClick={p.onRedo}
          >
            <Redo2 strokeWidth={1.75} aria-hidden />
          </IconButton>
          <Sep />
          <Select
            size="sm"
            aria-label={tr('数字格式')}
            wrapperClassName="w-24 shrink-0"
            value={preset?.id ?? 'custom'}
            options={fmtOptions}
            onChange={(e) => {
              const f = FORMAT_PRESETS.find((x) => x.id === e.target.value);
              if (f) p.onNumFmt(f.code);
            }}
          />
          <IconButton label={tr('减少小数位')} size="sm" onClick={() => p.onDecimals(-1)}>
            <span aria-hidden className="text-caption font-medium tabular-nums">
              .0
            </span>
          </IconButton>
          <IconButton label={tr('增加小数位')} size="sm" onClick={() => p.onDecimals(1)}>
            <span aria-hidden className="text-caption font-medium tabular-nums">
              .00
            </span>
          </IconButton>
          <Sep />
          <Select
            size="sm"
            aria-label={tr('字号')}
            wrapperClassName="w-16 shrink-0"
            value={String(st.fs ?? 11)}
            options={[...new Set([...FONT_SIZES, st.fs ?? 11])]
              .sort((a, b) => a - b)
              .map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(e) => {
              const n = Number(e.target.value);
              p.onStyle({ fs: n === 11 ? undefined : n });
            }}
          />
          <IconButton
            label={tr('加粗')}
            shortcut={`${p.mk}B`}
            size="sm"
            aria-pressed={!!st.b}
            variant={st.b ? 'subtle' : 'ghost'}
            onClick={() => toggle('b')}
          >
            <Bold strokeWidth={2} aria-hidden />
          </IconButton>
          <IconButton
            label={tr('斜体')}
            shortcut={`${p.mk}I`}
            size="sm"
            aria-pressed={!!st.i}
            variant={st.i ? 'subtle' : 'ghost'}
            onClick={() => toggle('i')}
          >
            <Italic strokeWidth={1.75} aria-hidden />
          </IconButton>
          <IconButton
            label={tr('下划线')}
            shortcut={`${p.mk}U`}
            size="sm"
            aria-pressed={!!st.u}
            variant={st.u ? 'subtle' : 'ghost'}
            onClick={() => toggle('u')}
          >
            <Underline strokeWidth={1.75} aria-hidden />
          </IconButton>
          <IconButton
            label={tr('删除线')}
            size="sm"
            aria-pressed={!!st.s}
            variant={st.s ? 'subtle' : 'ghost'}
            onClick={() => toggle('s')}
          >
            <Strikethrough strokeWidth={1.75} aria-hidden />
          </IconButton>
          <ColorMenu
            label={tr('文字颜色')}
            icon={<Type strokeWidth={1.75} aria-hidden className="size-4" />}
            value={st.fc}
            clearLabel={tr('自动（黑色）')}
            onPick={(c) => p.onStyle({ fc: c })}
          />
          <ColorMenu
            label={tr('填充颜色')}
            icon={<PaintBucket strokeWidth={1.75} aria-hidden className="size-4" />}
            value={st.bg}
            clearLabel={tr('无填充')}
            onPick={(c) => p.onStyle({ bg: c })}
          />
          <Menu
            label={tr('边框')}
            trigger={
              <IconButton label={tr('边框')} size="sm">
                <Grid2x2 strokeWidth={1.75} aria-hidden />
              </IconButton>
            }
          >
            <MenuItem icon={<Grid2x2 strokeWidth={1.75} />} onSelect={() => p.onBorders('all')}>
              {tr('所有框线')}
            </MenuItem>
            <MenuItem icon={<Square strokeWidth={1.75} />} onSelect={() => p.onBorders('outer')}>
              {tr('外侧框线')}
            </MenuItem>
            <MenuItem icon={<Grid2x2 strokeWidth={1.25} />} onSelect={() => p.onBorders('inner')}>
              {tr('内部框线')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => p.onBorders('top')}>{tr('上框线')}</MenuItem>
            <MenuItem onSelect={() => p.onBorders('bottom')}>{tr('下框线')}</MenuItem>
            <MenuItem onSelect={() => p.onBorders('left')}>{tr('左框线')}</MenuItem>
            <MenuItem onSelect={() => p.onBorders('right')}>{tr('右框线')}</MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<SquareDashed strokeWidth={1.75} />}
              onSelect={() => p.onBorders('none')}
            >
              {tr('无框线')}
            </MenuItem>
          </Menu>
          <Sep />
          <Menu
            label={tr('对齐')}
            trigger={
              <IconButton label={tr('对齐')} size="sm">
                {ha === 'center' ? (
                  <AlignCenter strokeWidth={1.75} aria-hidden />
                ) : ha === 'right' ? (
                  <AlignRight strokeWidth={1.75} aria-hidden />
                ) : (
                  <AlignLeft strokeWidth={1.75} aria-hidden />
                )}
              </IconButton>
            }
          >
            <MenuLabel>{tr('水平')}</MenuLabel>
            <MenuItem checked={!st.ha} onSelect={() => p.onStyle({ ha: undefined })}>
              {tr('常规（按内容）')}
            </MenuItem>
            <MenuItem
              icon={<AlignLeft strokeWidth={1.75} />}
              checked={st.ha === 'left'}
              onSelect={() => p.onStyle({ ha: 'left' })}
            >
              {tr('左对齐')}
            </MenuItem>
            <MenuItem
              icon={<AlignCenter strokeWidth={1.75} />}
              checked={st.ha === 'center'}
              onSelect={() => p.onStyle({ ha: 'center' })}
            >
              {tr('居中')}
            </MenuItem>
            <MenuItem
              icon={<AlignRight strokeWidth={1.75} />}
              checked={st.ha === 'right'}
              onSelect={() => p.onStyle({ ha: 'right' })}
            >
              {tr('右对齐')}
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>{tr('垂直')}</MenuLabel>
            <MenuItem checked={st.va === 'top'} onSelect={() => p.onStyle({ va: 'top' })}>
              {tr('顶端对齐')}
            </MenuItem>
            <MenuItem checked={st.va === 'middle'} onSelect={() => p.onStyle({ va: 'middle' })}>
              {tr('垂直居中')}
            </MenuItem>
            <MenuItem
              checked={!st.va || st.va === 'bottom'}
              onSelect={() => p.onStyle({ va: undefined })}
            >
              {tr('底端对齐')}
            </MenuItem>
          </Menu>
          <IconButton
            label={tr('自动换行')}
            size="sm"
            aria-pressed={!!st.wrap}
            variant={st.wrap ? 'subtle' : 'ghost'}
            onClick={() => toggle('wrap')}
          >
            <WrapText strokeWidth={1.75} aria-hidden />
          </IconButton>
          <IconButton
            label={p.merged ? tr('取消合并') : tr('合并单元格')}
            size="sm"
            aria-pressed={p.merged}
            variant={p.merged ? 'subtle' : 'ghost'}
            onClick={p.onMerge}
          >
            <Merge strokeWidth={1.75} aria-hidden />
          </IconButton>
          <Menu
            label={tr('冻结')}
            trigger={
              <IconButton
                label={tr('冻结窗格')}
                size="sm"
                variant={p.frozen.rows || p.frozen.cols ? 'subtle' : 'ghost'}
              >
                <Snowflake strokeWidth={1.75} aria-hidden />
              </IconButton>
            }
          >
            <MenuItem
              checked={p.frozen.rows === 1 && !p.frozen.cols}
              onSelect={() => p.onFreeze('row')}
            >
              {tr('冻结首行')}
            </MenuItem>
            <MenuItem
              checked={p.frozen.cols === 1 && !p.frozen.rows}
              onSelect={() => p.onFreeze('col')}
            >
              {tr('冻结首列')}
            </MenuItem>
            <MenuItem
              onSelect={() => p.onFreeze('here')}
              description={tr('冻结当前单元格上方的行和左侧的列')}
            >
              {tr('冻结至当前单元格')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              disabled={!p.frozen.rows && !p.frozen.cols}
              onSelect={() => p.onFreeze('none')}
            >
              {tr('取消冻结')}
            </MenuItem>
          </Menu>
          <Menu
            label={tr('排序和筛选')}
            trigger={
              <IconButton
                label={tr('排序和筛选')}
                size="sm"
                variant={p.filterOn ? 'subtle' : 'ghost'}
              >
                <Filter strokeWidth={1.75} aria-hidden />
              </IconButton>
            }
          >
            <MenuItem icon={<ArrowDownAZ strokeWidth={1.75} />} onSelect={() => p.onSort(true)}>
              {tr('升序排列')}
            </MenuItem>
            <MenuItem icon={<ArrowUpAZ strokeWidth={1.75} />} onSelect={() => p.onSort(false)}>
              {tr('降序排列')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Filter strokeWidth={1.75} />}
              checked={p.filterOn}
              onSelect={p.onToggleFilter}
            >
              {p.filterOn ? tr('关闭筛选') : tr('筛选')}
            </MenuItem>
          </Menu>
        </>
      )}
      <IconButton label={tr('查找和替换')} shortcut={`${p.mk}F`} size="sm" onClick={p.onFind}>
        <Search strokeWidth={1.75} aria-hidden />
      </IconButton>
      <IconButton label={tr('插入图表')} size="sm" onClick={p.onChart}>
        <BarChart3 strokeWidth={1.75} aria-hidden />
      </IconButton>
      <Menu
        label={tr('导入和导出')}
        trigger={
          <IconButton label={tr('导入和导出')} size="sm">
            <Download strokeWidth={1.75} aria-hidden />
          </IconButton>
        }
      >
        {p.editable && (
          <>
            <MenuItem
              icon={<FileUp strokeWidth={1.75} />}
              onSelect={p.onImport}
              description={tr('xlsx / csv，作为新工作表加入')}
            >
              {tr('导入 Excel')}
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        <MenuItem
          icon={<FileSpreadsheet strokeWidth={1.75} />}
          onSelect={p.onExportXlsx}
          description={tr('全部工作表，保留公式和样式')}
        >
          {tr('导出 Excel（.xlsx）')}
        </MenuItem>
        <MenuItem
          icon={<FileText strokeWidth={1.75} />}
          onSelect={p.onExportCsv}
          description={tr('当前工作表的显示值')}
        >
          {tr('导出 CSV')}
        </MenuItem>
        <MenuItem
          icon={<Printer strokeWidth={1.75} />}
          onSelect={p.onExportPdf}
          description={tr('打印视图，可另存为 PDF')}
        >
          {tr('导出 PDF')}
        </MenuItem>
      </Menu>
      <div className="ml-auto" />
      {p.ai}
    </div>
  );
}
