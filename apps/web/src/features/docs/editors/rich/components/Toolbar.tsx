import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import {
  AArrowDown,
  AArrowUp,
  AtSign,
  Baseline,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Bold,
  BookOpen,
  ChevronDown,
  Code,
  CodeXml,
  Columns3,
  Download,
  FileDown,
  FileInput,
  FilePlus2,
  FileText,
  FileUp,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  ListTodo,
  MessageSquareText,
  Minus,
  PaintBucket,
  Paintbrush,
  PanelTop,
  Paperclip,
  Presentation,
  Printer,
  Radical,
  Redo2,
  RemoveFormatting,
  Rows3,
  Ruler,
  Search,
  SeparatorHorizontal,
  Sigma,
  Sparkles,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  Table2,
  TableCellsMerge,
  TableCellsSplit,
  TableOfContents as TocIcon,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  TextQuote,
  Trash,
  Underline,
  Undo2,
  UnfoldVertical,
  StickyNote,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Popover,
} from '@/components/ui';
import type { EmbedKind } from '../embed/DocPicker';
import { cn } from '@/lib/cn';
import {
  BLOCK_STYLE_LABEL,
  BLOCK_STYLE_SHORTCUT,
  currentBlockStyle,
  setBlockStyle,
  type BlockStyle,
} from '../commands';
import { shortcutLabel } from '../lib/text';
import { ICON_STROKE } from './icons';
import { LinkForm } from './LinkForm';
import {
  ACTIVE,
  ColorMenu,
  Divider,
  DropButton,
  FontFamilyMenu,
  FontSizeMenu,
  IndentMenu,
  LineSpacingMenu,
  ListButton,
  SpacingMenu,
  TableGridPicker,
  Tool,
} from './ribbon/controls';
import { HIGHLIGHT_COLORS, TEXT_COLORS, stepFontSize } from '../word/format';
import { painterState, subscribePainter } from '../word/format-painter';
import { MARGIN_PRESETS, PAPER_SIZES, type PageSetup, type PaperSize } from '../word/page';
import { tr } from '@/lib/i18n';

type Align = 'left' | 'center' | 'right' | 'justify';

const ALIGN: Record<Align, { label: string; icon: LucideIcon; shortcut: string }> = {
  left: { label: tr('左对齐'), icon: TextAlignStart, shortcut: 'Mod-Shift-l' },
  center: { label: tr('居中'), icon: TextAlignCenter, shortcut: 'Mod-Shift-e' },
  right: { label: tr('右对齐'), icon: TextAlignEnd, shortcut: 'Mod-Shift-r' },
  justify: { label: tr('两端对齐'), icon: TextAlignJustify, shortcut: 'Mod-Shift-j' },
};

export type ExportKind = 'docx' | 'pdf' | 'html' | 'markdown';

/** Word 式功能（页面、查找、导入导出）由编辑器外壳提供 */
export interface WordControls {
  page: PageSetup;
  setPage: (patch: Partial<PageSetup>) => void;
  pageView: boolean;
  setPageView: (on: boolean) => void;
  openPageSetup: () => void;
  openFind: (replace: boolean) => void;
  importWord: () => void;
  exportAs: (kind: ExportKind) => void;
}

export interface ToolbarProps {
  editor: Editor;
  onAi: () => void;
  onMath: (kind: 'inline' | 'block') => void;
  onMedia: (kind: 'image' | 'attachment') => void;
  onEmbed: (kind: EmbedKind, createFirst?: boolean) => void;
  /** 评论侧栏开关与未解决数 */
  comments: { open: boolean; count: number; toggle: () => void };
  word: WordControls;
}

type Tab = 'home' | 'insert' | 'layout' | 'table';
const TAB_LABEL: Record<Tab, string> = {
  home: tr('开始'),
  insert: tr('插入'),
  layout: tr('布局'),
  table: tr('表格'),
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Word 式功能区：上面一行是“开始 / 插入 / 布局 / 表格”选项卡和常用按钮（查找、文件、评论、AI），
 * 下面一行是当前选项卡的工具。窄屏时工具行只显示放得下的部分，其余点“更多”展开（换行显示），不横向滚动。
 * 光标进入表格时自动出现“表格”选项卡。
 */
export function Toolbar({ editor, onAi, onMath, onMedia, onEmbed, comments, word }: ToolbarProps) {
  const [tab, setTab] = useState<Tab>('home');
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const align = (['center', 'right', 'justify'] as const).find((a) =>
        e.isActive({ textAlign: a }),
      );
      const text = e.getAttributes('textStyle');
      const para = e.isActive('heading')
        ? e.getAttributes('heading')
        : e.getAttributes('paragraph');
      const ordered = e.isActive('orderedList');
      const cell = e.isActive('tableHeader')
        ? e.getAttributes('tableHeader')
        : e.getAttributes('tableCell');
      const inTable = e.isActive('table');
      return {
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        block: currentBlockStyle(e),
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        code: e.isActive('code'),
        sup: e.isActive('superscript'),
        sub: e.isActive('subscript'),
        link: e.isActive('link'),
        color: str(text.color),
        fontFamily: str(text.fontFamily),
        fontSize: str(text.fontSize),
        highlight: e.isActive('highlight')
          ? (str(e.getAttributes('highlight').color) ?? HIGHLIGHT_COLORS[0]!.value)
          : null,
        align: (align ?? 'left') as Align,
        lineHeight: str(para.lineHeight),
        spaceBefore: numOrNull(para.spaceBefore),
        spaceAfter: numOrNull(para.spaceAfter),
        textIndent: numOrNull(para.textIndent),
        bulletList: e.isActive('bulletList'),
        orderedList: ordered,
        listStyle: str(e.getAttributes(ordered ? 'orderedList' : 'bulletList').listStyle),
        taskList: e.isActive('taskList'),
        blockquote: e.isActive('blockquote'),
        codeBlock: e.isActive('codeBlock'),
        table: inTable,
        cellBg: inTable ? str(cell.backgroundColor) : null,
        canMerge: inTable && e.can().mergeCells(),
        canSplit: inTable && e.can().splitCell(),
      };
    },
  });
  const painter = useSyncExternalStore(
    (fn) => subscribePainter(editor, fn),
    () => painterKey(editor),
    () => 'off',
  );

  // 离开表格时回到“开始”；进入表格不自动切换（避免打断正在用的选项卡）
  const activeTab: Tab = tab === 'table' && !s.table ? 'home' : tab;
  const tabs: Tab[] = s.table
    ? ['home', 'insert', 'layout', 'table']
    : ['home', 'insert', 'layout'];
  const chain = () => editor.chain().focus();
  const AlignIcon = ALIGN[s.align].icon;

  const home = (
    <>
      <Tool
        label={tr('撤销')}
        shortcut="Mod-z"
        disabled={!s.canUndo}
        onClick={() => chain().undo().run()}
      >
        <Undo2 strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('重做')}
        shortcut="Mod-Shift-z"
        disabled={!s.canRedo}
        onClick={() => chain().redo().run()}
      >
        <Redo2 strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={painter === 'sticky' ? tr('格式刷（连续，Esc 退出）') : tr('格式刷（双击连续使用）')}
        shortcut="Mod-Alt-Shift-c"
        active={painter !== 'off'}
        onClick={() =>
          painter !== 'off' ? chain().dropFormat().run() : chain().pickFormat(false).run()
        }
        onDoubleClick={() => chain().pickFormat(true).run()}
      >
        <Paintbrush strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('清除格式')}
        shortcut="Mod-\\"
        onClick={() => chain().clearFormatting().run()}
      >
        <RemoveFormatting strokeWidth={ICON_STROKE} />
      </Tool>
      <Divider />
      <Menu
        label={tr('段落样式')}
        trigger={
          <DropButton
            label={tr('段落样式：{value}', { value: BLOCK_STYLE_LABEL[s.block] })}
            width="w-[5.5rem]"
          >
            {BLOCK_STYLE_LABEL[s.block]}
          </DropButton>
        }
      >
        {(Object.keys(BLOCK_STYLE_LABEL) as BlockStyle[]).map((style) => (
          <MenuItem
            key={style}
            checked={s.block === style}
            shortcut={shortcutLabel(BLOCK_STYLE_SHORTCUT[style])}
            onSelect={() => setBlockStyle(editor, style)}
          >
            <span className={cn(style !== 'paragraph' && 'font-semibold')}>
              {BLOCK_STYLE_LABEL[style]}
            </span>
          </MenuItem>
        ))}
      </Menu>
      <FontFamilyMenu editor={editor} value={s.fontFamily} />
      <FontSizeMenu editor={editor} value={s.fontSize} />
      <Tool
        label={tr('增大字号')}
        shortcut="Mod-Shift-."
        onClick={() => chain().setFontSize(stepFontSize(s.fontSize, 1)).run()}
      >
        <AArrowUp strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('减小字号')}
        shortcut="Mod-Shift-,"
        onClick={() => chain().setFontSize(stepFontSize(s.fontSize, -1)).run()}
      >
        <AArrowDown strokeWidth={ICON_STROKE} />
      </Tool>
      <Divider />
      <Tool
        label={tr('加粗')}
        shortcut="Mod-b"
        active={s.bold}
        onClick={() => chain().toggleBold().run()}
      >
        <Bold strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('斜体')}
        shortcut="Mod-i"
        active={s.italic}
        onClick={() => chain().toggleItalic().run()}
      >
        <Italic strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('下划线')}
        shortcut="Mod-u"
        active={s.underline}
        onClick={() => chain().toggleUnderline().run()}
      >
        <Underline strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('删除线')}
        shortcut="Mod-Shift-s"
        active={s.strike}
        onClick={() => chain().toggleStrike().run()}
      >
        <Strikethrough strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('上标')}
        shortcut="Mod-."
        active={s.sup}
        onClick={() => chain().toggleSuperscript().run()}
      >
        <Superscript strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('下标')}
        shortcut="Mod-,"
        active={s.sub}
        onClick={() => chain().toggleSubscript().run()}
      >
        <Subscript strokeWidth={ICON_STROKE} />
      </Tool>
      <ColorMenu
        label={tr('文字颜色')}
        icon={<Baseline size={16} strokeWidth={ICON_STROKE} aria-hidden />}
        value={s.color}
        colors={TEXT_COLORS}
        noneLabel={tr('自动')}
        onPick={(c) => (c ? chain().setColor(c).run() : chain().unsetColor().run())}
      />
      <ColorMenu
        label={tr('突出显示')}
        icon={<Highlighter size={16} strokeWidth={ICON_STROKE} aria-hidden />}
        value={s.highlight}
        colors={HIGHLIGHT_COLORS}
        noneLabel={tr('无颜色')}
        onPick={(c) =>
          c ? chain().setHighlight({ color: c }).run() : chain().unsetHighlight().run()
        }
      />
      <Tool
        label={tr('行内代码')}
        shortcut="Mod-e"
        active={s.code}
        onClick={() => chain().toggleCode().run()}
      >
        <Code strokeWidth={ICON_STROKE} />
      </Tool>
      <LinkTool editor={editor} active={s.link} />
      <Divider />
      <Menu
        label={tr('对齐方式')}
        trigger={
          <IconButton size="sm" label={tr('对齐：{label}', { label: ALIGN[s.align].label })}>
            <AlignIcon strokeWidth={ICON_STROKE} />
          </IconButton>
        }
      >
        {(Object.keys(ALIGN) as Align[]).map((a) => {
          const Icon = ALIGN[a].icon;
          return (
            <MenuItem
              key={a}
              icon={<Icon strokeWidth={ICON_STROKE} />}
              checked={s.align === a}
              shortcut={shortcutLabel(ALIGN[a].shortcut)}
              onSelect={() =>
                a === 'left' ? chain().unsetTextAlign().run() : chain().setTextAlign(a).run()
              }
            >
              {ALIGN[a].label}
            </MenuItem>
          );
        })}
      </Menu>
      <ListButton
        editor={editor}
        ordered={false}
        active={s.bulletList}
        current={s.listStyle}
        icon={<List strokeWidth={ICON_STROKE} />}
      />
      <ListButton
        editor={editor}
        ordered
        active={s.orderedList}
        current={s.listStyle}
        icon={<ListOrdered strokeWidth={ICON_STROKE} />}
      />
      <Tool label={tr('减少缩进')} shortcut="Mod-[" onClick={() => chain().outdentBlock().run()}>
        <ListIndentDecrease strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool label={tr('增加缩进')} shortcut="Mod-]" onClick={() => chain().indentBlock().run()}>
        <ListIndentIncrease strokeWidth={ICON_STROKE} />
      </Tool>
      <LineSpacingMenu
        editor={editor}
        value={s.lineHeight}
        before={s.spaceBefore}
        after={s.spaceAfter}
        icon={<UnfoldVertical strokeWidth={ICON_STROKE} />}
      />
      <Tool
        label={tr('待办')}
        shortcut="Mod-Shift-9"
        active={s.taskList}
        onClick={() => chain().toggleTaskList().run()}
      >
        <ListTodo strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('引用')}
        shortcut="Mod-Shift-b"
        active={s.blockquote}
        onClick={() => chain().toggleBlockquote().run()}
      >
        <TextQuote strokeWidth={ICON_STROKE} />
      </Tool>
    </>
  );

  const insert = (
    <>
      <Tool label={tr('图片')} onClick={() => onMedia('image')}>
        <ImageIcon strokeWidth={ICON_STROKE} />
      </Tool>
      <TableGridPicker
        icon={<Table strokeWidth={ICON_STROKE} />}
        onPick={(rows, cols) => chain().insertTable({ rows, cols, withHeaderRow: true }).run()}
      />
      <Tool label={tr('附件')} onClick={() => onMedia('attachment')}>
        <Paperclip strokeWidth={ICON_STROKE} />
      </Tool>
      <Menu
        label={tr('插入公式')}
        trigger={
          <IconButton size="sm" label={tr('公式')}>
            <Sigma strokeWidth={ICON_STROKE} />
          </IconButton>
        }
      >
        <MenuItem icon={<Radical strokeWidth={ICON_STROKE} />} onSelect={() => onMath('inline')}>
          {tr('行内公式')}
        </MenuItem>
        <MenuItem icon={<Sigma strokeWidth={ICON_STROKE} />} onSelect={() => onMath('block')}>
          {tr('公式块')}
        </MenuItem>
      </Menu>
      <Tool
        label={tr('代码块')}
        shortcut="Mod-Alt-c"
        active={s.codeBlock}
        onClick={() => chain().toggleCodeBlock().run()}
      >
        <CodeXml strokeWidth={ICON_STROKE} />
      </Tool>
      <Divider />
      <Tool label={tr('分页符')} shortcut="Mod-Enter" onClick={() => chain().setPageBreak().run()}>
        <SeparatorHorizontal strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool label={tr('分割线')} onClick={() => chain().setHorizontalRule().run()}>
        <Minus strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool label={tr('目录')} onClick={() => chain().insertTableOfContents().run()}>
        <TocIcon strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('脚注')}
        shortcut="Mod-Alt-f"
        onClick={() => chain().insertFootnote('').run()}
      >
        <StickyNote strokeWidth={ICON_STROKE} />
      </Tool>
      <Divider />
      <Tool label={tr('提及成员')} onClick={() => chain().insertContent('@').run()}>
        <AtSign strokeWidth={ICON_STROKE} />
      </Tool>
      <Menu
        label={tr('嵌入')}
        trigger={
          <Button
            size="sm"
            variant="ghost"
            className="px-2"
            leftIcon={<Table2 strokeWidth={ICON_STROKE} />}
            rightIcon={<ChevronDown strokeWidth={ICON_STROKE} />}
          >
            {tr('嵌入')}
          </Button>
        }
      >
        <MenuItem icon={<Table2 strokeWidth={ICON_STROKE} />} onSelect={() => onEmbed('sheet')}>
          {tr('嵌入表格')}
        </MenuItem>
        <MenuItem
          icon={<Presentation strokeWidth={ICON_STROKE} />}
          onSelect={() => onEmbed('slides')}
        >
          {tr('嵌入幻灯片')}
        </MenuItem>
        <MenuItem icon={<FileInput strokeWidth={ICON_STROKE} />} onSelect={() => onEmbed('doc')}>
          {tr('嵌入文档')}
        </MenuItem>
        <MenuItem
          icon={<FilePlus2 strokeWidth={ICON_STROKE} />}
          onSelect={() => onEmbed('sheet', true)}
        >
          {tr('新建表格并嵌入')}
        </MenuItem>
      </Menu>
    </>
  );

  const layout = (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={word.pageView}
        className={cn('px-2', word.pageView && ACTIVE)}
        leftIcon={
          word.pageView ? (
            <FileText strokeWidth={ICON_STROKE} />
          ) : (
            <BookOpen strokeWidth={ICON_STROKE} />
          )
        }
        title={tr('页面视图：按纸张大小分页显示；关闭后为连续视图')}
        onClick={() => word.setPageView(!word.pageView)}
      >
        {tr('页面视图')}
      </Button>
      <Divider />
      <Menu
        label={tr('纸张大小')}
        trigger={
          <DropButton
            label={tr('纸张：{label}', { label: PAPER_SIZES[word.page.size].label })}
            width="w-[4.5rem]"
          >
            {word.page.size}
          </DropButton>
        }
      >
        {(Object.keys(PAPER_SIZES) as PaperSize[]).map((k) => (
          <MenuItem
            key={k}
            checked={word.page.size === k}
            description={tr('{width} × {height} 毫米', {
              width: PAPER_SIZES[k].width,
              height: PAPER_SIZES[k].height,
            })}
            onSelect={() => word.setPage({ size: k })}
          >
            {PAPER_SIZES[k].label}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        label={tr('纸张方向')}
        trigger={
          <DropButton label={tr('纸张方向')} width="w-[4.5rem]">
            {word.page.orientation === 'landscape' ? tr('横向') : tr('纵向')}
          </DropButton>
        }
      >
        <MenuItem
          checked={word.page.orientation === 'portrait'}
          onSelect={() => word.setPage({ orientation: 'portrait' })}
        >
          {tr('纵向')}
        </MenuItem>
        <MenuItem
          checked={word.page.orientation === 'landscape'}
          onSelect={() => word.setPage({ orientation: 'landscape' })}
        >
          {tr('横向')}
        </MenuItem>
      </Menu>
      <Menu
        label={tr('页边距')}
        trigger={
          <DropButton label={tr('页边距')} width="w-[4.5rem]">
            {tr('页边距')}
          </DropButton>
        }
      >
        {MARGIN_PRESETS.map((p) => (
          <MenuItem
            key={p.label}
            checked={(['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const).every(
              (k) => p.value[k] === word.page[k],
            )}
            description={tr('上下 {marginTop} · 左右 {marginLeft} 毫米', {
              marginTop: p.value.marginTop,
              marginLeft: p.value.marginLeft,
            })}
            onSelect={() => word.setPage(p.value)}
          >
            {p.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Ruler strokeWidth={ICON_STROKE} />} onSelect={word.openPageSetup}>
          {tr('页面设置…')}
        </MenuItem>
      </Menu>
      <Divider />
      <SpacingMenu editor={editor} which="before" value={s.spaceBefore} />
      <SpacingMenu editor={editor} which="after" value={s.spaceAfter} />
      <IndentMenu editor={editor} value={s.textIndent} />
    </>
  );

  const table = (
    <>
      <Tool label={tr('上方插入行')} onClick={() => chain().addRowBefore().run()}>
        <BetweenHorizontalStart strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool label={tr('下方插入行')} onClick={() => chain().addRowAfter().run()}>
        <BetweenHorizontalEnd strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool label={tr('左侧插入列')} onClick={() => chain().addColumnBefore().run()}>
        <BetweenVerticalStart strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool label={tr('右侧插入列')} onClick={() => chain().addColumnAfter().run()}>
        <BetweenVerticalEnd strokeWidth={ICON_STROKE} />
      </Tool>
      <Divider />
      <Tool
        label={tr('合并单元格')}
        disabled={!s.canMerge}
        onClick={() => chain().mergeCells().run()}
      >
        <TableCellsMerge strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool
        label={tr('拆分单元格')}
        disabled={!s.canSplit}
        onClick={() => chain().splitCell().run()}
      >
        <TableCellsSplit strokeWidth={ICON_STROKE} />
      </Tool>
      <ColorMenu
        label={tr('单元格底色')}
        icon={<PaintBucket size={16} strokeWidth={ICON_STROKE} aria-hidden />}
        value={s.cellBg}
        colors={HIGHLIGHT_COLORS}
        noneLabel={tr('无底色')}
        onPick={(c) => chain().setCellBackground(c).run()}
      />
      <Tool label={tr('切换标题行')} onClick={() => chain().toggleHeaderRow().run()}>
        <PanelTop strokeWidth={ICON_STROKE} />
      </Tool>
      <Divider />
      <Tool label={tr('删除行')} onClick={() => chain().deleteRow().run()}>
        <Rows3 strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool label={tr('删除列')} onClick={() => chain().deleteColumn().run()}>
        <Columns3 strokeWidth={ICON_STROKE} />
      </Tool>
      <Tool label={tr('删除表格')} danger onClick={() => chain().deleteTable().run()}>
        <Trash strokeWidth={ICON_STROKE} />
      </Tool>
    </>
  );

  const groups: Record<Tab, ReactNode> = { home, insert, layout, table };

  return (
    <div
      role="toolbar"
      aria-label={tr('编辑工具栏')}
      className="sticky top-0 z-sticky border-b border-line bg-canvas/80 backdrop-blur-md"
    >
      <div className="mx-auto flex items-center gap-1 px-2 pt-1 sm:px-4">
        <div role="tablist" aria-label={tr('功能区')} className="flex min-w-0 items-center">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`rich-ribbon-tab-${t}`}
              aria-selected={activeTab === t}
              aria-controls="rich-ribbon-panel"
              onClick={() => setTab(t)}
              className={cn(
                'relative h-8 shrink-0 px-2.5 text-small transition-colors duration-(--dur-fast)',
                activeTab === t ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg',
                t === 'table' && 'text-accent-text',
              )}
            >
              {TAB_LABEL[t]}
              <span
                aria-hidden
                className={cn(
                  'absolute inset-x-2 bottom-0 h-0.5 origin-center rounded-full bg-accent transition-transform duration-(--dur-base)',
                  activeTab === t ? 'scale-x-100' : 'scale-x-0',
                )}
              />
            </button>
          ))}
        </div>
        <span className="min-w-0 flex-1" />
        <IconButton
          size="sm"
          label={tr('查找和替换')}
          shortcut={shortcutLabel('Mod-f')}
          onClick={() => word.openFind(false)}
        >
          <Search strokeWidth={ICON_STROKE} />
        </IconButton>
        <FileMenu word={word} />
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={comments.open}
          aria-label={tr('评论{value}', {
            value: comments.count > 0 ? tr('（{count} 条未解决）', { count: comments.count }) : '',
          })}
          className={cn('px-2', comments.open && ACTIVE)}
          leftIcon={<MessageSquareText strokeWidth={ICON_STROKE} />}
          title={tr('评论（选中文字后 {value}）', { value: shortcutLabel('Mod-Alt-m') })}
          onClick={comments.toggle}
        >
          <span className="hidden sm:inline">{tr('评论')}</span>
          {comments.count > 0 ? <span className="tabular-nums">{comments.count}</span> : null}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="px-2 text-agent-text hover:bg-agent-soft hover:text-agent-text"
          leftIcon={<Sparkles strokeWidth={ICON_STROKE} />}
          title={tr('AI 助手（{value}，空行按空格）', { value: shortcutLabel('Mod-j') })}
          onClick={onAi}
        >
          AI
        </Button>
      </div>
      <OverflowRow
        key={activeTab}
        id="rich-ribbon-panel"
        labelledBy={`rich-ribbon-tab-${activeTab}`}
      >
        {groups[activeTab]}
      </OverflowRow>
    </div>
  );
}

function painterKey(editor: Editor): 'off' | 'once' | 'sticky' {
  const p = painterState(editor);
  return !p.active ? 'off' : p.sticky ? 'sticky' : 'once';
}

function LinkTool({ editor, active }: { editor: Editor; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      label={tr('编辑链接')}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <IconButton
          size="sm"
          label={tr('链接')}
          aria-pressed={active}
          className={cn(active && ACTIVE)}
        >
          <Link strokeWidth={ICON_STROKE} />
        </IconButton>
      }
    >
      <LinkForm editor={editor} onDone={() => setOpen(false)} />
    </Popover>
  );
}

function FileMenu({ word }: { word: WordControls }) {
  return (
    <Menu
      label={tr('导入与导出')}
      align="end"
      trigger={
        <IconButton size="sm" label={tr('导入与导出')}>
          <Download strokeWidth={ICON_STROKE} />
        </IconButton>
      }
    >
      <MenuItem
        icon={<FileUp strokeWidth={ICON_STROKE} />}
        onSelect={word.importWord}
        description={tr('插入到光标处或替换全文')}
      >
        {tr('导入 Word')}
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>{tr('导出')}</MenuLabel>
      <MenuItem
        icon={<FileDown strokeWidth={ICON_STROKE} />}
        onSelect={() => word.exportAs('docx')}
        description={tr('保留格式、表格、图片、脚注、目录')}
      >
        {tr('Word（.docx）')}
      </MenuItem>
      <MenuItem
        icon={<Printer strokeWidth={ICON_STROKE} />}
        onSelect={() => word.exportAs('pdf')}
        description={tr('打开打印版式，选择“另存为 PDF”')}
      >
        {tr('PDF / 打印')}
      </MenuItem>
      <MenuItem icon={<CodeXml strokeWidth={ICON_STROKE} />} onSelect={() => word.exportAs('html')}>
        HTML
      </MenuItem>
      <MenuItem
        icon={<FileText strokeWidth={ICON_STROKE} />}
        onSelect={() => word.exportAs('markdown')}
      >
        Markdown
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Ruler strokeWidth={ICON_STROKE} />} onSelect={word.openPageSetup}>
        {tr('页面设置…')}
      </MenuItem>
    </Menu>
  );
}

/**
 * 工具行：一行放不下时把放不下的藏起来，右侧出现“更多”，点开后整组换行显示。
 * 用 flex-wrap + 限高一行，内容高于一行即溢出。
 */
function OverflowRow({
  id,
  labelledBy,
  children,
}: {
  id: string;
  labelledBy: string;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    // 弹层触发器外面包着 display: contents 的 span，没有 offsetTop，所以看整行的滚动高度
    const check = () => setOverflow(row.scrollHeight > row.clientHeight + 2);
    check();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(check);
    ro.observe(row);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="flex items-start gap-1 px-2 pb-1 sm:px-4">
      <div
        ref={rowRef}
        id={id}
        role="tabpanel"
        aria-labelledby={labelledBy}
        className={cn(
          'flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 overflow-hidden py-0.5',
          expanded ? 'max-h-none' : 'max-h-9',
        )}
      >
        {children}
      </div>
      {(overflow || expanded) && (
        <IconButton
          size="sm"
          label={expanded ? tr('收起工具') : tr('更多工具')}
          aria-expanded={expanded}
          aria-controls={id}
          className="mt-0.5 shrink-0"
          onClick={() => setExpanded((e) => !e)}
        >
          <ChevronDown
            strokeWidth={ICON_STROKE}
            className={cn('transition-transform duration-(--dur-base)', expanded && 'rotate-180')}
          />
        </IconButton>
      )}
    </div>
  );
}
