/**
 * 找出源码里的数学区域（$…$、$$…$$、\(…\)、\[…\]、equation / align 等环境），
 * 供编辑器把公式染成 agent 色。返回的区间不含注释（注释另有样式）。纯函数。
 */

const MATH_ENV = /^(equation|align|gather|multline|eqnarray|flalign|alignat|displaymath|math)\*?$/;
const VERBATIM_ENV = /^(verbatim|Verbatim|lstlisting|minted|comment)\*?$/;

export type MathRange = [from: number, to: number];

export function findMathRanges(text: string): MathRange[] {
  const out: MathRange[] = [];
  const n = text.length;
  let i = 0;

  /** 从 start 扫描到 close（不含注释），把区间推入 out，返回 close 之后的位置 */
  const scanMath = (start: number, contentFrom: number, close: string | RegExp): number => {
    let segStart = start;
    let j = contentFrom;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        if (typeof close === 'string' && close.startsWith('\\') && text.startsWith(close, j)) {
          const end = j + close.length;
          out.push([segStart, end]);
          return end;
        }
        if (typeof close !== 'string' && text.startsWith('\\end', j)) {
          const m = close.exec(text.slice(j, j + 40));
          if (m && m.index === 0) {
            const end = j + m[0].length;
            out.push([segStart, end]);
            return end;
          }
        }
        j += 2;
        continue;
      }
      if (
        c === '$' &&
        typeof close === 'string' &&
        close.startsWith('$') &&
        text.startsWith(close, j)
      ) {
        const end = j + close.length;
        out.push([segStart, end]);
        return end;
      }
      if (c === '%') {
        if (j > segStart) out.push([segStart, j]);
        const nl = text.indexOf('\n', j);
        if (nl === -1) return n;
        j = nl + 1;
        segStart = j;
        continue;
      }
      // 行内公式遇到空行视为没闭合
      if (c === '\n' && typeof close === 'string' && (close === '$' || close === '\\)')) {
        let k = j + 1;
        while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\r')) k += 1;
        if (text[k] === '\n') {
          if (j > segStart) out.push([segStart, j]);
          return j;
        }
      }
      j += 1;
    }
    if (n > segStart) out.push([segStart, n]);
    return n;
  };

  while (i < n) {
    const c = text[i];
    if (c === '%') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '$') {
      if (text[i + 1] === '$') i = scanMath(i, i + 2, '$$');
      else i = scanMath(i, i + 1, '$');
      continue;
    }
    if (c === '\\') {
      const next = text[i + 1];
      if (next === '[') {
        i = scanMath(i, i + 2, '\\]');
        continue;
      }
      if (next === '(') {
        i = scanMath(i, i + 2, '\\)');
        continue;
      }
      if (text.startsWith('begin', i + 1)) {
        const m = /^\\begin\s*\{([^}]*)\}/.exec(text.slice(i, i + 60));
        if (m) {
          const env = (m[1] ?? '').trim();
          const after = i + m[0].length;
          if (MATH_ENV.test(env)) {
            const esc = env.replace(/\*/g, '\\*');
            i = scanMath(i, after, new RegExp(`\\\\end\\s*\\{${esc}\\}`));
            continue;
          }
          if (VERBATIM_ENV.test(env)) {
            const endTag = `\\end{${env}}`;
            const e = text.indexOf(endTag, after);
            i = e === -1 ? n : e + endTag.length;
            continue;
          }
          i = after;
          continue;
        }
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  return out;
}
