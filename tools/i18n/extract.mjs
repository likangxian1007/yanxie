#!/usr/bin/env node
/* global process, console */
/**
 * 列出代码里所有 tr('…') 的 key，和英文词典对比：
 *   node tools/i18n/extract.mjs            打印缺少英文的条数
 *   node tools/i18n/extract.mjs --missing  把缺的 key 写到 tools/i18n/missing.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DICT_DIR = path.join(ROOT, 'apps/web/src/i18n/en');

export function collectKeys() {
  const files = execFileSync('git', ['ls-files', 'apps/web/src', 'packages/shared/src'], {
    cwd: ROOT,
  })
    .toString()
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
  const keys = new Map();
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!src.includes('tr(')) continue;
    const sf = ts.createSourceFile(
      file,
      src,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'tr') {
        const a = n.arguments[0];
        if (
          a &&
          (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) &&
          !keys.has(a.text)
        )
          keys.set(a.text, file);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return keys;
}

export function loadDict() {
  const all = {};
  for (const f of fs.readdirSync(DICT_DIR)) {
    if (f.endsWith('.json'))
      Object.assign(all, JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8')));
  }
  return all;
}

const keys = collectKeys();
const dict = loadDict();
const missing = [...keys].filter(([k]) => !(k in dict));
console.log(`keys ${keys.size}, missing ${missing.length}`);
if (process.argv.includes('--missing')) {
  fs.writeFileSync(
    path.join(ROOT, 'tools/i18n/missing.json'),
    JSON.stringify(
      missing.map(([k, f]) => ({ k, f })),
      null,
      1,
    ),
  );
}
