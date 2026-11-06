/**
 * 英文词典的守门测试：
 * - 代码里每个 tr('中文') 都要有英文（否则英文界面会漏中文）
 * - 英文译文里不能有中文字符
 * - 译文里的 {占位符} 必须和中文 key 一致（少了会显示不出数据，多了会原样露出 {x}）
 * - 源码里不能有没包 tr() 的中文字符串（codemod --dry 报告的那类）
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const SRC_DIRS = ['apps/web/src', 'packages/shared/src'];
const DICT_DIR = path.join(ROOT, 'apps/web/src/i18n/en');
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(e.name))
      out.push(p);
  }
  return out;
}

function collectKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const dir of SRC_DIRS)
    for (const file of walk(path.join(ROOT, dir))) {
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes('tr(')) continue;
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'tr') {
          const a = n.arguments[0];
          if (
            a &&
            (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) &&
            !keys.has(a.text)
          )
            keys.set(a.text, path.relative(ROOT, file));
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  return keys;
}

function loadDict(): Record<string, string> {
  const all: Record<string, string> = {};
  for (const f of fs.readdirSync(DICT_DIR))
    if (f.endsWith('.json'))
      Object.assign(all, JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8')));
  return all;
}

const placeholders = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

describe('英文词典', () => {
  const keys = collectKeys();
  const dict = loadDict();

  it('每个 tr() 文案都有英文', () => {
    const missing = [...keys].filter(([k]) => !(k in dict)).map(([k, f]) => `${f}: ${k}`);
    expect(missing).toEqual([]);
  });

  it('英文译文里没有中文', () => {
    const bad = Object.entries(dict)
      .filter(([, v]) => CJK.test(JSON.stringify(v)))
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('占位符与中文一致', () => {
    const bad = Object.entries(dict)
      .flatMap(([k, v]) =>
        (typeof v === 'string' ? [v] : Object.values(v as Record<string, string>)).map(
          (one) => [k, one] as const,
        ),
      )
      .filter(([k, v]) => v !== '' && placeholders(k) !== placeholders(v))
      .map(([k, v]) => `${k} => ${v}`);
    expect(bad).toEqual([]);
  });
});
