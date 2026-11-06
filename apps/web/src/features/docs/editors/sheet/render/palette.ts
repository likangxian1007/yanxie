import type { BorderSide } from '../model/schema';

/**
 * 单元格内容的颜色（用户数据，不是界面颜色）：字色 / 填充色色板、默认边框。
 * 与 Excel / 飞书的取色一致，导出 xlsx 后颜色不变，所以必须是具体的 #rrggbb。
 */

/** 色板：灰阶 + 标准色 + 浅色 + 中间色 + 深色 */
export const CELL_PALETTE: string[][] = [
  ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#d9d9d9', '#efefef', '#ffffff'],
  ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0'],
  ['#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#cfe2f3', '#d9d2e9', '#ead1dc'],
  ['#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6fa8dc', '#8e7cc3', '#c27ba0'],
  ['#1f4e79', '#2e75b6', '#833c0b', '#7f6000', '#375623', '#203864', '#3f3151', '#7b2c49'],
];

/** 工具栏“边框”菜单画的线 */
export const DEFAULT_BORDER: BorderSide = { s: 'thin', c: '#000000' };
