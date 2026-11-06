import * as Y from 'yjs';
import { createCellMap } from './deck';
import type { TableElement } from './types';

/** 表格行列操作（在调用方的事务里；行高、列宽数组同步增删，总宽度保持不变） */

function rowsOf(el: TableElement): Y.Array<Y.Array<Y.Map<unknown>>> | null {
  const v = el.map?.get('cells');
  return v instanceof Y.Array ? (v as Y.Array<Y.Array<Y.Map<unknown>>>) : null;
}

export function insertRow(el: TableElement, at: number): void {
  const rows = rowsOf(el);
  if (!rows || !el.map) return;
  const cols = el.colW.length;
  const row = new Y.Array<Y.Map<unknown>>();
  row.push(Array.from({ length: cols }, () => createCellMap({})));
  rows.insert(Math.max(0, Math.min(at, rows.length)), [row]);
  const rowH = [...el.rowH];
  const h = rowH[Math.min(at, rowH.length - 1)] || el.h / Math.max(1, el.cells.length);
  rowH.splice(at, 0, h);
  el.map.set('rowH', rowH);
  el.map.set('h', el.h + h);
}

export function deleteRow(el: TableElement, at: number): void {
  const rows = rowsOf(el);
  if (!rows || !el.map || rows.length <= 1) return;
  rows.delete(at, 1);
  const rowH = [...el.rowH];
  const [h] = rowH.splice(at, 1);
  el.map.set('rowH', rowH);
  el.map.set('h', Math.max(10, el.h - (h || el.h / el.cells.length)));
}

export function insertCol(el: TableElement, at: number): void {
  const rows = rowsOf(el);
  if (!rows || !el.map) return;
  rows.forEach((row) => row.insert(Math.max(0, Math.min(at, row.length)), [createCellMap({})]));
  const n = el.colW.length + 1;
  const w = el.w / n;
  const colW = el.colW.map((c) => (c * (el.w - w)) / el.w);
  colW.splice(at, 0, w);
  el.map.set('colW', colW);
}

export function deleteCol(el: TableElement, at: number): void {
  const rows = rowsOf(el);
  if (!rows || !el.map || el.colW.length <= 1) return;
  rows.forEach((row) => {
    if (at < row.length) row.delete(at, 1);
  });
  const colW = [...el.colW];
  const [w] = colW.splice(at, 1);
  const rest = el.w - (w ?? 0);
  el.map.set(
    'colW',
    colW.map((c) => (rest > 0 ? (c * el.w) / rest : el.w / colW.length)),
  );
}

export function setCellProp(el: TableElement, r: number, c: number, key: string, value: unknown) {
  const m = el.cells[r]?.[c]?.map;
  if (!m) return;
  if (value === null || value === undefined || value === false) m.delete(key);
  else m.set(key, value);
}
