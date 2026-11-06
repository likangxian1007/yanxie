import {
  Bold,
  BookMarked,
  ChevronDown,
  Columns2,
  Download,
  Eye,
  FileArchive,
  FileCode2,
  FileDown,
  Heading,
  Italic,
  Languages,
  List,
  ListOrdered,
  PenLine,
  Plus,
  Printer,
  Redo2,
  RefreshCw,
  Sigma,
  Sparkles,
  Table2,
  Undo2,
  Image as ImageIcon,
  Wand2,
  Wrench,
  AlignLeft,
  Heading2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Button,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Separator,
  Tabs,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { isMac } from '../../shared/dom';
import type { LatexViewMode } from '../layout';
import type { LatexIssue } from '../compile/issues';
import { SNIPPETS, type SnippetId, type WrapCommand } from '../editor/snippets';
import { IssuesPopover } from './IssuesPopover';
import { tr } from '@/lib/i18n';

export type LatexAiAction = 'academic' | 'translate_en' | 'latex_fix' | 'custom';

interface LatexToolbarProps {
  editable: boolean;
  narrow: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSnippet: (id: SnippetId) => void;
  onWrap: (cmd: WrapCommand) => void;
  hasSelection: boolean;
  aiBusy: boolean;
  onAiAction: (action: LatexAiAction) => void;
  onAiSection: () => void;
  view: LatexViewMode;
  onViewChange: (v: LatexViewMode) => void;
  onDownload: () => void;
  /** 下载整个工程（含 .bib、图片）为 .zip */
  onDownloadZip?: () => void;
  onPrint: () => void;
  compileIssues: LatexIssue[] | null;
  draftIssues: LatexIssue[];
  pending: boolean;
  onJumpIssue: (issue: LatexIssue) => void;
  onFixIssue: (issue: LatexIssue) => void;
  /** 服务器能编译 */
  compileAvailable: boolean;
  compiling: boolean;
  onCompile: (force: boolean) => void;
  autoCompile: boolean;
  onAutoCompileChange: (v: boolean) => void;
  /** 下载编译出的 PDF（不可编译时为 null，导出菜单退回打印） */
  onDownloadPdf: (() => void) | null;
}

const SNIPPET_ICON: Record<SnippetId, ReactNode> = {
  section: <Heading strokeWidth={1.75} aria-hidden />,
  subsection: <Heading2 strokeWidth={1.75} aria-hidden />,
  equation: <Sigma strokeWidth={1.75} aria-hidden />,
  align: <AlignLeft strokeWidth={1.75} aria-hidden />,
  figure: <ImageIcon strokeWidth={1.75} aria-hidden />,
  table: <Table2 strokeWidth={1.75} aria-hidden />,
  itemize: <List strokeWidth={1.75} aria-hidden />,
  enumerate: <ListOrdered strokeWidth={1.75} aria-hidden />,
  cite: <BookMarked strokeWidth={1.75} aria-hidden />,
};

const AI_ITEMS: Array<{
  action: LatexAiAction;
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    action: 'academic',
    label: tr('润色'),
    description: tr('改成更地道的学术表达'),
    icon: <PenLine strokeWidth={1.75} aria-hidden />,
  },
  {
    action: 'translate_en',
    label: tr('译成英文'),
    description: tr('保留命令、公式和引用'),
    icon: <Languages strokeWidth={1.75} aria-hidden />,
  },
  {
    action: 'latex_fix',
    label: tr('修复这段'),
    description: tr('修正语法和不配对的环境'),
    icon: <Wrench strokeWidth={1.75} aria-hidden />,
  },
  {
    action: 'custom',
    label: tr('按指令改…'),
    description: tr('告诉 AI 你想怎么改'),
    icon: <Wand2 strokeWidth={1.75} aria-hidden />,
  },
];

export function LatexToolbar(props: LatexToolbarProps) {
  const {
    editable,
    narrow,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    onSnippet,
    onWrap,
    hasSelection,
    aiBusy,
    onAiAction,
    onAiSection,
    view,
    onViewChange,
    onDownload,
    onDownloadZip,
    onPrint,
    compileIssues,
    draftIssues,
    pending,
    onJumpIssue,
    onFixIssue,
    compileAvailable,
    compiling,
    onCompile,
    autoCompile,
    onAutoCompileChange,
    onDownloadPdf,
  } = props;
  const mod = isMac() ? '⌘' : 'Ctrl+';

  const viewItems = narrow
    ? [
        {
          value: 'source' as const,
          label: tr('源码'),
          icon: <FileCode2 size={14} strokeWidth={1.75} aria-hidden />,
        },
        {
          value: 'preview' as const,
          label: tr('预览'),
          icon: <Eye size={14} strokeWidth={1.75} aria-hidden />,
        },
      ]
    : [
        {
          value: 'source' as const,
          label: tr('源码'),
          icon: <FileCode2 size={14} strokeWidth={1.75} aria-hidden />,
        },
        {
          value: 'split' as const,
          label: tr('分栏'),
          icon: <Columns2 size={14} strokeWidth={1.75} aria-hidden />,
        },
        {
          value: 'preview' as const,
          label: tr('预览'),
          icon: <Eye size={14} strokeWidth={1.75} aria-hidden />,
        },
      ];
  const viewValue: LatexViewMode = narrow && view === 'split' ? 'source' : view;

  return (
    <div
      role="toolbar"
      aria-label={tr('LaTeX 工具栏')}
      className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-2"
    >
      <div className="ltx-toolbar-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <IconButton
          label={tr('撤销')}
          shortcut={`${mod}Z`}
          size="sm"
          disabled={!editable || !canUndo}
          onClick={onUndo}
        >
          <Undo2 strokeWidth={1.75} aria-hidden />
        </IconButton>
        <IconButton
          label={tr('重做')}
          shortcut={isMac() ? '⇧⌘Z' : 'Ctrl+Y'}
          size="sm"
          disabled={!editable || !canRedo}
          onClick={onRedo}
        >
          <Redo2 strokeWidth={1.75} aria-hidden />
        </IconButton>
        <Separator orientation="vertical" className="mx-1 h-5" />

        <Menu
          label={tr('插入')}
          trigger={
            <Button
              variant="ghost"
              size="sm"
              disabled={!editable}
              leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
              rightIcon={<ChevronDown strokeWidth={1.75} aria-hidden className="hidden sm:block" />}
            >
              <span className="hidden sm:inline">{tr('插入')}</span>
            </Button>
          }
        >
          <MenuLabel>{tr('插入片段')}</MenuLabel>
          {SNIPPETS.map((s) => (
            <MenuItem
              key={s.id}
              icon={SNIPPET_ICON[s.id]}
              description={s.description}
              onSelect={() => onSnippet(s.id)}
            >
              {s.label}
            </MenuItem>
          ))}
        </Menu>
        <IconButton
          label={tr('加粗')}
          shortcut={`${mod}B`}
          size="sm"
          disabled={!editable}
          onClick={() => onWrap('textbf')}
        >
          <Bold strokeWidth={1.75} aria-hidden />
        </IconButton>
        <IconButton
          label={tr('斜体')}
          shortcut={`${mod}I`}
          size="sm"
          disabled={!editable}
          onClick={() => onWrap('textit')}
        >
          <Italic strokeWidth={1.75} aria-hidden />
        </IconButton>
        <Separator orientation="vertical" className="mx-1 h-5" />

        <Menu
          label="AI"
          trigger={
            <Button
              variant="ghost"
              size="sm"
              disabled={!editable}
              aria-busy={aiBusy}
              leftIcon={<Sparkles strokeWidth={1.75} aria-hidden className="text-agent" />}
              rightIcon={<ChevronDown strokeWidth={1.75} aria-hidden className="hidden sm:block" />}
            >
              AI
            </Button>
          }
        >
          <MenuLabel>{hasSelection ? tr('处理选中的源码') : tr('先在源码里选中一段')}</MenuLabel>
          {AI_ITEMS.map((item) => (
            <MenuItem
              key={item.action}
              icon={item.icon}
              description={item.description}
              disabled={!hasSelection}
              onSelect={() => onAiAction(item.action)}
            >
              {item.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            icon={<Sparkles strokeWidth={1.75} aria-hidden className="text-agent" />}
            description={tr('给一个主题，写出完整小节')}
            onSelect={onAiSection}
          >
            {tr('AI 写一个小节…')}
          </MenuItem>
        </Menu>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {pending && (
          <span className="hidden text-caption text-fg-subtle md:inline" aria-live="polite">
            {tr('排版中')}
          </span>
        )}
        {compileAvailable && (
          <div className="flex items-center">
            <Button
              variant="secondary"
              size="sm"
              className="rounded-r-none"
              aria-busy={compiling}
              title={tr('编译 PDF（{mod}S）', { mod })}
              leftIcon={
                <RefreshCw
                  strokeWidth={1.75}
                  aria-hidden
                  className={cn(compiling && 'motion-safe:animate-spin')}
                />
              }
              onClick={() => onCompile(false)}
            >
              <span className="ltx-view-label">{compiling ? tr('编译中') : tr('编译')}</span>
            </Button>
            <Menu
              label={tr('编译选项')}
              align="end"
              trigger={
                <IconButton
                  label={tr('编译选项')}
                  size="sm"
                  variant="secondary"
                  className="-ml-px rounded-l-none"
                >
                  <ChevronDown strokeWidth={1.75} aria-hidden />
                </IconButton>
              }
            >
              <MenuItem
                checked={autoCompile}
                keepOpen
                description={tr('停止输入几秒后自动重新编译')}
                onSelect={() => onAutoCompileChange(!autoCompile)}
              >
                {tr('自动编译')}
              </MenuItem>
              <MenuItem
                icon={<RefreshCw strokeWidth={1.75} aria-hidden />}
                description={tr('忽略缓存，从头编译一遍')}
                onSelect={() => onCompile(true)}
              >
                {tr('强制重新编译')}
              </MenuItem>
            </Menu>
          </div>
        )}
        <IssuesPopover
          compileIssues={compileIssues}
          draftIssues={draftIssues}
          pending={pending}
          canFix={editable}
          onJump={onJumpIssue}
          onFix={onFixIssue}
        />
        <Tabs
          variant="segmented"
          size="sm"
          layoutId="latex-view-mode"
          aria-label={tr('视图')}
          value={viewValue}
          onValueChange={onViewChange}
          items={viewItems.map((it) => ({
            ...it,
            label: <span className="ltx-view-label">{it.label}</span>,
          }))}
        />
        <Menu
          label={tr('导出')}
          align="end"
          trigger={
            <IconButton label={tr('导出')} size="sm">
              <Download strokeWidth={1.75} aria-hidden />
            </IconButton>
          }
        >
          <MenuItem
            icon={<FileDown strokeWidth={1.75} aria-hidden />}
            description={tr('下载 LaTeX 源码文件')}
            onSelect={onDownload}
          >
            {tr('下载 .tex')}
          </MenuItem>
          {onDownloadZip ? (
            <MenuItem
              icon={<FileArchive strokeWidth={1.75} aria-hidden />}
              description={tr('main.tex、参考文献和图片打成一个包，可在本地或 Overleaf 编译')}
              onSelect={onDownloadZip}
            >
              {tr('下载工程 .zip')}
            </MenuItem>
          ) : null}
          {onDownloadPdf ? (
            <MenuItem
              icon={<FileDown strokeWidth={1.75} aria-hidden />}
              description={tr('下载编译出的 PDF（和 Overleaf 排版一致）')}
              onSelect={onDownloadPdf}
            >
              {tr('下载 PDF')}
            </MenuItem>
          ) : null}
          <MenuItem
            icon={<Printer strokeWidth={1.75} aria-hidden />}
            description={
              onDownloadPdf
                ? tr('用草稿预览打印，排版和编译结果不同')
                : tr('服务器不能编译：打开打印页，选择“另存为 PDF”')
            }
            onSelect={onPrint}
          >
            {onDownloadPdf ? tr('打印草稿预览') : tr('导出 PDF（打印）')}
          </MenuItem>
        </Menu>
      </div>
    </div>
  );
}
