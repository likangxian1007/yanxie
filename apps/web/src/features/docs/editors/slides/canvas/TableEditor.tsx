import { useEffect, useRef } from 'react';
import type * as Y from 'yjs';
import { useYTextBinding } from '../../shared/bindYText';
import { cssFont } from '../model/themes';
import type { TableElement, Theme } from '../model/types';
import { cellStyle, pt } from '../render/ElementView';
import { tr } from '@/lib/i18n';

export interface CellPos {
  r: number;
  c: number;
}

interface Props {
  el: TableElement;
  theme: Theme;
  active: CellPos | null;
  onActive: (pos: CellPos | null) => void;
  origin: unknown;
  onUndo: () => void;
  onRedo: () => void;
}

/** 编辑中的表格：点格子选中，选中格是绑定 Y.Text 的输入框；Tab / Shift+Tab 换格，Esc 退出 */
export function TableEditor({ el, theme, active, onActive, origin, onUndo, onRedo }: Props) {
  const move = (dir: 1 | -1) => {
    if (!active) return;
    const cols = el.colW.length;
    let i = active.r * cols + active.c;
    const total = el.cells.length * cols;
    for (let n = 0; n < total; n += 1) {
      i = (i + dir + total) % total;
      const r = Math.floor(i / cols);
      const c = i % cols;
      if (el.cells[r]?.[c] && !el.cells[r]![c]!.hidden) {
        onActive({ r, c });
        return;
      }
    }
  };
  return (
    <table
      className="sl-table"
      style={{
        fontSize: pt(el.style.fontSize),
        fontFamily: cssFont(el.style.fontFamily),
        color: el.style.color,
      }}
    >
      <colgroup>
        {el.colW.map((w, i) => (
          <col key={i} style={{ width: pt(w) }} />
        ))}
      </colgroup>
      <tbody>
        {el.cells.map((row, r) => (
          <tr key={r} style={{ height: el.rowH[r] ? pt(el.rowH[r]!) : undefined }}>
            {row.map((cell, c) => {
              if (cell.hidden) return null;
              const isActive = active?.r === r && active.c === c;
              return (
                <td
                  key={c}
                  data-r={r}
                  data-c={c}
                  colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                  rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                  style={{
                    ...cellStyle(el, theme, r, c),
                    outline: isActive ? '2px solid var(--accent)' : undefined,
                    outlineOffset: -2,
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (!isActive) onActive({ r, c });
                  }}
                >
                  {isActive && cell.ytext ? (
                    <CellInput
                      key={`${r}:${c}`}
                      ytext={cell.ytext}
                      origin={origin}
                      onUndo={onUndo}
                      onRedo={onRedo}
                      onTab={(back) => move(back ? -1 : 1)}
                      onExit={() => onActive(null)}
                      label={tr('第 {value} 行第 {value2} 列', { value: r + 1, value2: c + 1 })}
                    />
                  ) : (
                    cell.text
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CellInput({
  ytext,
  origin,
  onUndo,
  onRedo,
  onTab,
  onExit,
  label,
}: {
  ytext: Y.Text;
  origin: unknown;
  onUndo: () => void;
  onRedo: () => void;
  onTab: (back: boolean) => void;
  onExit: () => void;
  label: string;
}) {
  const bind = useYTextBinding<HTMLTextAreaElement>(ytext, { origin, onUndo, onRedo });
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        bind(el);
      }}
      aria-label={label}
      rows={1}
      className="sl-cell-input"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Tab') {
          e.preventDefault();
          onTab(e.shiftKey);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onExit();
        }
      }}
    />
  );
}
