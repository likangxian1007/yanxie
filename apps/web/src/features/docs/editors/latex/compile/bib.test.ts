import { describe, expect, it } from 'vitest';
import { bibText, formatBibEntry, parseBib, splitAuthors } from './bib';

describe('parseBib', () => {
  it('花括号 / 引号 / 数字 / @string 宏与 # 拼接', () => {
    const { entries, errors } = parseBib(`
% 注释行 @article{ignored, title={x}}
@string{cvpr = "Computer Vision and Pattern Recognition"}
@Article{he2016,
  author = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  title = {Deep Residual Learning for {Image} Recognition},
  booktitle = "Proc. " # cvpr,
  year = 2016,
  month = jun,
}

@comment{ anything {nested} }
@inproceedings(chen2020,
  title = "A {Simple} Framework",
  author = "Ting Chen and others",
  year = "2020"
)
`);
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.type, e.key, e.line])).toEqual([
      ['article', 'he2016', 4],
      ['inproceedings', 'chen2020', 13],
    ]);
    expect(entries[0]!.fields).toMatchObject({
      title: 'Deep Residual Learning for {Image} Recognition',
      booktitle: 'Proc. Computer Vision and Pattern Recognition',
      year: '2016',
      month: 'June',
    });
    expect(entries[1]!.fields.title).toBe('A {Simple} Framework');
  });

  it('坏条目报错但不影响后面的条目', () => {
    const { entries, errors } = parseBib(`@article{bad,
  title = {Unclosed
@book{good, title={Fine}, year={1999}}
@misc{nokey}
`);
    expect(entries.map((e) => e.key)).toContain('nokey');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain('bad');
    const ok = parseBib('@article{x, title = {A}}\n@book{good, title={Fine}, year={1999}}');
    expect(ok.entries.map((e) => e.key)).toEqual(['x', 'good']);
  });

  it('空文件、只有注释', () => {
    expect(parseBib('').entries).toEqual([]);
    expect(parseBib('% nothing here\n').entries).toEqual([]);
  });
});

describe('格式化', () => {
  it('作者：Last, First → First Last；others → et al.', () => {
    expect(splitAuthors('He, Kaiming and Zhang, Xiangyu')).toEqual(['Kaiming He', 'Xiangyu Zhang']);
    expect(splitAuthors('{Research Group and Friends} and Li Si')).toEqual([
      'Research Group and Friends',
      'Li Si',
    ]);
    expect(splitAuthors('Ting Chen and others')).toEqual(['Ting Chen', 'others']);
  });

  it('去掉花括号保护、重音与 ~', () => {
    expect(bibText('{Sch\\"{o}lkopf}~and {GANs}--{VAEs}')).toBe('Scholkopf and GANs–VAEs');
  });

  it('formatBibEntry', () => {
    const [e] = parseBib(
      '@article{a, author={A One and B Two and C Three}, title={T}, journal={J}, year={2021}}',
    ).entries;
    expect(formatBibEntry(e!)).toEqual({
      authors: 'A One, B Two, and C Three',
      title: 'T',
      venue: 'J',
      year: '2021',
    });
    const [m] = parseBib('@misc{b, author={X and others}, title={Y}, eprint={2101.00001}}').entries;
    expect(formatBibEntry(m!)).toMatchObject({ authors: 'X et al.', venue: 'arXiv:2101.00001' });
  });
});
