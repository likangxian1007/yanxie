import type { DocumentOutlineItem } from '@srh/shared';
import type { BibEntry } from '../compile/bib';

/** 预览转换器报出的问题（带 1 起的源码行号），在“编译问题”面板里列出。 */
export interface LatexWarning {
  line: number;
  message: string;
  /** 所在文件；省略 = main.tex */
  file?: string;
  /** 省略 = warning */
  severity?: 'error' | 'warning' | 'info';
  /** 能否交给 AI 修复；省略 = 可以（缺参考文献这类 AI 补不出来的为 false） */
  fixable?: boolean;
}

/**
 * 预览的一个顶层块（段落、标题、公式、浮动体、列表……）。
 * line / endLine 是它在源码里的起止行，用于编辑区与预览的同步滚动、点击跳转。
 */
export interface LatexBlock {
  line: number;
  endLine: number;
  html: string;
}

/** 大纲项对应的源码位置（与 outline 一一对应，下标相同）。 */
export interface LatexSection {
  /** 1 起的源码行号 */
  line: number;
  /** 大纲层级：1 = \section（有 \chapter 时 \chapter 为 1） */
  level: number;
  /** 纯文本标题（不含编号） */
  heading: string;
  /** 编号，如 "1.2"；不编号（带 *、参考文献）为空串 */
  number: string;
  /** 预览里对应元素的 data-anchor */
  anchor: string;
}

export interface LatexRenderResult {
  /** 所有块拼起来的 HTML（未清洗，展示前必须经过 sanitize） */
  html: string;
  blocks: LatexBlock[];
  outline: DocumentOutlineItem[];
  sections: LatexSection[];
  warnings: LatexWarning[];
  /** \title 的纯文本（没有则 null） */
  title: string | null;
}

export interface LatexRenderOptions {
  /** \today 用的日期（测试里固定） */
  today?: Date;
  /**
   * 工程里的 .bib 文件（文件名 → 解析出的条目）。给了它，\bibliography{…} 的引用会按引用顺序编号，
   * 并列出作者、标题、年份；不给则只列 key（旧行为）。
   */
  bib?: Record<string, BibEntry[]>;
}
