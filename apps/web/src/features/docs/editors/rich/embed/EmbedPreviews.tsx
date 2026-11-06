import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { isError } from '../../sheet/engine/values';
import { colName } from '../../sheet/lib/a1';
import { displayOf, Workbook } from '../../sheet/model/workbook';
import { cssOfStyle } from '../../sheet/render/style';
import { useDeck, useSlide } from '../../slides/model/hooks';
import { SlidePreview } from '../../slides/render/DeckPreview';
import { ICON_STROKE } from '../components/icons';
import { tr } from '@/lib/i18n';

/** 内嵌表格的只读预览最多显示的行列（完整内容去原文档看） */
const EMBED_SHEET_MAX = { rows: 200, cols: 26 } as const;

/**
 * 内嵌表格的只读预览：订阅被嵌文档的工作簿（和表格编辑器同一套模型与公式引擎），
 * 原表格里任何人（包括 agent）改了单元格，这里立刻更新。多张工作表时可以切换。
 * 旧结构由服务端在载入时迁移，这里只读不写。
 */
export function SheetPreview({ doc }: { doc: Y.Doc }) {
  const wb = useMemo(() => new Workbook(doc), [doc]);
  useEffect(() => () => wb.destroy(), [wb]);
  const version = useSyncExternalStore(wb.subscribe, wb.getVersion, wb.getVersion);
  void version;
  const ids = wb.sheetIds().filter((id) => !wb.sheetInfo(id).hidden);
  const [picked, setPicked] = useState<string | null>(null);
  const sid = picked && ids.includes(picked) ? picked : ids[0];
  const sheet = sid ? wb.sheet(sid) : null;
  const bounds = sheet?.usedBounds() ?? null;
  const tabs =
    ids.length > 1 ? (
      <div className="sticky left-0 flex gap-1 border-t border-line bg-canvas px-2 py-1">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setPicked(id)}
            className={cn(
              'rounded-sm px-2 py-0.5 text-caption',
              id === sid
                ? 'bg-surface font-medium text-accent-text'
                : 'text-fg-muted hover:bg-subtle',
            )}
          >
            {wb.sheetInfo(id).name}
          </button>
        ))}
      </div>
    ) : null;
  if (!sheet || !bounds) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-center justify-center text-small text-fg-subtle">
          {tr('这个表格还是空的')}
        </div>
        {tabs}
      </div>
    );
  }
  const rows = Math.min(bounds.rows, EMBED_SHEET_MAX.rows);
  const cols = Math.min(bounds.cols, EMBED_SHEET_MAX.cols);
  const colIdx = Array.from({ length: cols }, (_, c) => c).filter((c) => !sheet.colHidden(c));
  const rowIdx = Array.from({ length: rows }, (_, r) => r).filter((r) => !sheet.rowHidden(r));
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <table className="border-separate border-spacing-0 text-small text-fg tabular-nums">
          <colgroup>
            <col style={{ width: 40 }} />
            {colIdx.map((c) => (
              <col key={c} style={{ width: sheet.colWidth(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-sticky h-7 border-r border-b border-line bg-subtle" />
              {colIdx.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="sticky top-0 h-7 border-r border-b border-line bg-subtle px-2 text-caption font-medium text-fg-subtle"
                >
                  {colName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowIdx.map((r) => (
              <tr key={r}>
                <th
                  scope="row"
                  className="sticky left-0 h-7 border-r border-b border-line bg-subtle px-1 text-center text-caption font-normal text-fg-subtle"
                >
                  {r + 1}
                </th>
                {colIdx.map((c) => {
                  const raw = sheet.raw(r, c);
                  const v = raw ? sheet.value(r, c) : null;
                  const d = raw ? displayOf(sheet, r, c) : { text: '' };
                  const css = cssOfStyle(sheet.style(r, c), v, d.color);
                  return (
                    <td
                      key={c}
                      title={d.text.length > 12 ? d.text : undefined}
                      className={cn(
                        'h-7 max-w-0 truncate border-r border-b border-line px-2',
                        isError(v) && 'text-danger',
                      )}
                      style={{
                        textAlign: css.textAlign,
                        fontWeight: css.fontWeight,
                        fontStyle: css.fontStyle,
                        textDecoration: css.textDecoration,
                        color: css.color,
                        backgroundColor: css.backgroundColor,
                      }}
                    >
                      {d.text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {(bounds.rows > rows || bounds.cols > cols) && (
          <p className="px-3 py-2 text-caption text-fg-subtle">
            {tr('只显示了前 {rows} 行、{cols} 列，完整内容在原表格里。', { rows, cols })}
          </p>
        )}
      </div>
      {tabs}
    </div>
  );
}

/** 内嵌幻灯片：一页一页翻看（实时跟随原幻灯片的修改） */
export function SlidesPreview({ doc }: { doc: Y.Doc }) {
  const { refs: slides, deck } = useDeck(doc);
  const [index, setIndex] = useState(0);
  const i = Math.min(index, Math.max(0, slides.length - 1));
  const slide = useSlide(slides[i], deck);
  if (!slide) {
    return (
      <div className="flex aspect-video items-center justify-center text-small text-fg-subtle">
        {tr('这份幻灯片还没有内容')}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-3">
      <SlidePreview
        slide={slide}
        deck={deck}
        className="w-full overflow-hidden rounded-md border border-line shadow-xs"
      />
      <div className="flex items-center justify-center gap-2" data-node-interactive>
        <IconButton
          size="sm"
          label={tr('上一页')}
          disabled={i === 0}
          onClick={() => setIndex(i - 1)}
        >
          <ChevronLeft strokeWidth={ICON_STROKE} />
        </IconButton>
        <span className="min-w-14 text-center text-caption text-fg-muted tabular-nums">
          {i + 1} / {slides.length}
        </span>
        <IconButton
          size="sm"
          label={tr('下一页')}
          disabled={i >= slides.length - 1}
          onClick={() => setIndex(i + 1)}
        >
          <ChevronRight strokeWidth={ICON_STROKE} />
        </IconButton>
      </div>
    </div>
  );
}
