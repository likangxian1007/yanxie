import { describe, expect, it } from 'vitest';
import { endsWithQuestion } from '../src/modules/threads/service';
import { pdfPageCount, texErrors, texWarnings } from '../src/agents/tools/latex';
import { plotsWithoutImage } from '../src/agents/tools/notebooks';
import { goalReminder } from '../src/agents/runtime/turn';

/** 第二轮终验里后端小问题的单元测试 */
describe('线程状态：问成员问题 ≠ 交付待验收', () => {
  it('以问号结尾（中英文、带引号、后面跟附件行）', () => {
    expect(endsWithQuestion('数据路径在哪里？')).toBe(true);
    expect(endsWithQuestion('Which split?')).toBe(true);
    expect(endsWithQuestion('你看用 A 还是 B？」')).toBe(true);
    expect(endsWithQuestion('要不要加消融？\n\n[方案](#doc_1)')).toBe(true);
    expect(endsWithQuestion('已完成，见[方案](#doc_1)。')).toBe(false);
    expect(endsWithQuestion('为什么 loss 不降？我查了，是学习率太大。')).toBe(false);
  });
});

describe('compile_latex 的日志解析', () => {
  const log = [
    'This is XeTeX',
    '! Undefined control sequence.',
    'l.42 \\foo',
    '        bar',
    "LaTeX Warning: Citation `smith2020' on page 1 undefined on input line 12.",
    "LaTeX Warning: File `fig/acc.png' not found on input line 30.",
    "! LaTeX Error: File `fig/acc.png' not found.",
    'LaTeX Warning: There were undefined references.',
  ].join('\n');

  it('错误带行号', () => {
    const errs = texErrors(log);
    expect(errs[0]).toBe('Undefined control sequence.（l.42 \\foo）');
    expect(errs[1]).toContain('fig/acc.png');
  });

  it('未定义引用和缺失文件进警告', () => {
    const w = texWarnings(log);
    expect(w.some((x) => x.includes('smith2020'))).toBe(true);
    expect(w.some((x) => x.includes('There were undefined references'))).toBe(true);
  });

  it('PDF 页数不把 /Pages 算进去', () => {
    const pdf = Buffer.from(
      '%PDF-1.5\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page /Parent 1 0 R >>',
      'latin1',
    );
    expect(pdfPageCount(pdf)).toBe(2);
  });
});

describe('notebook 画图却没有图像输出时提醒', () => {
  const img = {
    output_type: 'display_data',
    data: { 'image/png': 'iVBOR', 'text/plain': '<Figure>' },
    metadata: {},
  } as never;
  it('Agg + savefig 没出图 → 提醒', () => {
    const src =
      'import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nplt.plot([1,2])\nplt.savefig("a.png")';
    expect(plotsWithoutImage(src, [])).toBe(true);
  });
  it('出了图 / 没画图 / 报错了 → 不提醒', () => {
    expect(plotsWithoutImage('plt.plot([1]); plt.show()', [img])).toBe(false);
    expect(plotsWithoutImage('print(1)', [])).toBe(false);
    expect(
      plotsWithoutImage('plt.plot(x)', [
        { output_type: 'error', ename: 'NameError', evalue: 'x', traceback: [] } as never,
      ]),
    ).toBe(false);
  });
});

describe('任务目标提醒', () => {
  it('带上任务锚点并要求自查', () => {
    const r = goalReminder('线程「消融实验」\n发起消息（张三）：跑学习率消融');
    expect(r).toContain('线程「消融实验」');
    expect(r).toContain('是在做这件事吗');
  });
});
