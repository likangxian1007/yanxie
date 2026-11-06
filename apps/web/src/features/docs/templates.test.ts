import { describe, expect, it } from 'vitest';
import { DocumentKind } from '@srh/shared';
import { DOC_TEMPLATES, templateDocTitle, templatesByKind, UNTITLED_TITLE } from './templates';

function tableRows(md: string): string[][] {
  return md
    .trim()
    .split('\n')
    .map((l) =>
      l
        .replace(/^\||\|$/gu, '')
        .split('|')
        .map((c) => c.trim()),
    );
}

const byId = (id: string) => {
  const t = DOC_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`缺少模板 ${id}`);
  return t;
};

describe('DOC_TEMPLATES', () => {
  it('id 唯一；每种类型都有空白模板与至少两个实用模板', () => {
    expect(new Set(DOC_TEMPLATES.map((t) => t.id)).size).toBe(DOC_TEMPLATES.length);
    for (const kind of DocumentKind.options) {
      const list = templatesByKind(kind);
      expect(list.filter((t) => t.blank)).toHaveLength(1);
      expect(list.filter((t) => !t.blank).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('文档模板齐全且以小节组织', () => {
    for (const title of ['实验周报', '论文阅读笔记', '研究计划书', '会议纪要']) {
      const t = DOC_TEMPLATES.find((x) => x.title === title);
      expect(t?.kind).toBe('doc');
      expect(t?.markdown).toMatch(/^## /mu);
    }
    expect(byId('weekly-report').markdown).toContain('## 下周计划');
  });

  it('实验数据记录表：表头与 3 行示例，每行列数一致', () => {
    const rows = tableRows(byId('experiment-sheet').markdown);
    expect(rows[0]).toEqual([
      '实验编号',
      '日期',
      '模型',
      '数据集',
      '学习率',
      'batch',
      'epoch',
      'acc',
      'loss',
      '备注',
    ]);
    expect(rows).toHaveLength(5); // 表头 + 分隔 + 3 行
    for (const r of rows) expect(r).toHaveLength(10);
  });

  it('文献追踪表是规整的 markdown 表格', () => {
    const rows = tableRows(byId('literature-sheet').markdown);
    const cols = rows[0]?.length ?? 0;
    expect(cols).toBeGreaterThanOrEqual(6);
    for (const r of rows) expect(r).toHaveLength(cols);
  });

  it('组会汇报幻灯片：以 ## 分页，约 6 页', () => {
    const pages = byId('group-meeting-slides').markdown.match(/^## .+$/gmu) ?? [];
    expect(pages).toHaveLength(6);
    expect(pages.map((p) => p.slice(3))).toEqual(
      expect.arrayContaining(['本周进展', '实验结果', '问题与讨论', '下周计划', 'Q&A']),
    );
    expect(byId('paper-sharing-slides').markdown.match(/^## /gmu)?.length).toBeGreaterThanOrEqual(
      5,
    );
  });

  it.each(['latex-article', 'latex-ctexart'])('%s 是完整可编译的论文骨架', (id) => {
    const src = byId(id).markdown;
    expect(src).toMatch(/\\documentclass(\[[^\]]*\])?\{(article|ctexart)\}/u);
    for (const s of [
      '\\usepackage{amsmath,amssymb}',
      '\\title{',
      '\\author{',
      '\\maketitle',
      '\\begin{abstract}',
      '\\begin{equation}',
      '\\begin{align}',
      '\\begin{table}',
      '\\begin{tabular}',
      '\\begin{thebibliography}',
      '\\end{document}',
    ]) {
      expect(src).toContain(s);
    }
    // 环境成对出现
    const begins = [...src.matchAll(/\\begin\{(\w+)\}/gu)].map((m) => m[1]);
    const ends = [...src.matchAll(/\\end\{(\w+)\}/gu)].map((m) => m[1]);
    expect(begins.sort()).toEqual(ends.sort());
    // 两条参考文献，且正文里的 \cite 都能找到
    const keys = [...src.matchAll(/\\bibitem\{([^}]+)\}/gu)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    const cited = [...src.matchAll(/\\cite\{([^}]+)\}/gu)].flatMap((m) => (m[1] ?? '').split(','));
    expect(cited.length).toBeGreaterThan(0);
    for (const c of cited) expect(keys).toContain(c.trim());
  });

  it('空白模板新建出“未命名…”，其他模板用模板名', () => {
    expect(templateDocTitle(byId('blank-sheet'))).toBe(UNTITLED_TITLE.sheet);
    expect(templateDocTitle(byId('weekly-report'))).toBe('实验周报');
  });
});
