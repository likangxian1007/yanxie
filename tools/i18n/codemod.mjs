#!/usr/bin/env node
/* global process, URL, console */
/**
 * 把写死的中文界面文案改成 tr('中文原文') 调用（可重复运行，已改过的不会再改）。
 *
 *   node tools/i18n/codemod.mjs [--dry] [路径前缀...]     默认 apps/web/src packages/shared/src
 *
 * 规则见 tools/i18n/README.md。拿不准会影响逻辑的地方（比较、正则、字符串查找、类型位置）
 * 不改，写进 tools/i18n/skipped.txt 由人工确认；确认无需翻译的行在行尾或上一行加 `// i18n-ignore`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')),
  '../..',
);
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const prefixes = args.filter((a) => !a.startsWith('--'));
const TARGETS = prefixes.length ? prefixes : ['apps/web/src', 'packages/shared/src'];

export const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const TR_NAMES = new Set(['tr']);
const LOCALE_CALLS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);
const INTL_CTORS = new Set([
  'NumberFormat',
  'DateTimeFormat',
  'RelativeTimeFormat',
  'PluralRules',
  'ListFormat',
]);
const LOOKUP_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'split',
  'indexOf',
  'lastIndexOf',
  'match',
  'matchAll',
  'replace',
  'replaceAll',
  'search',
  'test',
  'has',
  'get',
  'set',
  'delete',
  'localeCompare',
]);
/** 这些文件里的中文不是界面文案（按文档内容语言生成、或只给 AI 看），不自动改 */
const IGNORE_FILES = [
  /\.test\.tsx?$/,
  /\/test\//,
  /apps\/web\/src\/lib\/i18n\.ts$/,
  /packages\/shared\/src\/i18n\.ts$/,
];

function lsFiles() {
  const out = execFileSync('git', ['ls-files', ...TARGETS], { cwd: ROOT }).toString();
  return out
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts'))
    .filter((f) => !IGNORE_FILES.some((re) => re.test(f)));
}

export function quote(s) {
  return (
    "'" +
    s
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029') +
    "'"
  );
}

/** 与 Babel / TS 相同的 JSX 文本空白规则 */
export function cleanJsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let last = 0;
  lines.forEach((l, i) => {
    if (/[^ \t]/.test(l)) last = i;
  });
  let out = '';
  lines.forEach((line, i) => {
    const isFirst = i === 0;
    const isLast = i === lines.length - 1;
    let t = line.replace(/\t/g, ' ');
    if (!isFirst) t = t.replace(/^[ ]+/, '');
    if (!isLast) t = t.replace(/[ ]+$/, '');
    if (t) {
      if (i !== last) t += ' ';
      out += t;
    }
  });
  return out;
}

function isTrCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    TR_NAMES.has(node.expression.text)
  );
}

/** 节点里是否还有没包进 tr() 的中文字面量 */
function hasLooseCjk(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (isTrCall(n)) {
      n.arguments.slice(1).forEach(visit);
      return;
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CJK.test(n.text))
      found = true;
    else if (ts.isTemplateExpression(n)) {
      if ([n.head, ...n.templateSpans.map((s) => s.literal)].some((p) => CJK.test(p.text)))
        found = true;
    } else if (ts.isJsxText(n) && CJK.test(n.text)) found = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function containsJsx(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
}

function placeholderName(expr, used, literalText) {
  let base = 'value';
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e))
    e = e.expression;
  if (ts.isIdentifier(e)) base = e.text;
  else if (ts.isPropertyAccessExpression(e)) base = e.name.text;
  else if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const obj = e.expression.expression;
    base = ts.isIdentifier(obj)
      ? obj.text
      : ts.isPropertyAccessExpression(obj)
        ? obj.name.text
        : 'value';
  }
  if (base === 'length' || base === 'size') base = 'count';
  base = base.replace(/^_+/, '').replace(/[^\w]/g, '') || 'value';
  let name = base;
  let i = 2;
  while (used.has(name) || literalText.includes(`{${name}}`)) name = `${base}${i++}`;
  used.add(name);
  return name;
}

/** 由若干文本片段和表达式拼出 key 与参数对象 */
function buildCall(parts, trName, sf) {
  const used = new Set();
  const literalText = parts.filter((p) => typeof p === 'string').join('');
  let key = '';
  const props = [];
  for (const p of parts) {
    if (typeof p === 'string') key += p;
    else {
      const name = placeholderName(p, used, literalText);
      key += `{${name}}`;
      const text = p.getText(sf);
      props.push(text === name ? name : `${name}: ${text}`);
    }
  }
  return props.length
    ? `${trName}(${quote(key)}, { ${props.join(', ')} })`
    : `${trName}(${quote(key)})`;
}

function lineIgnored(sf, node) {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  if (sf.text.includes('i18n-ignore-file')) return true;
  const lines = sf.text.split('\n');
  return /i18n-ignore/.test(lines[line] ?? '') || /i18n-ignore/.test(lines[line - 1] ?? '');
}

/** 字面量能否安全包进 tr()：返回 null 表示可以，否则返回跳过原因 */
function skipReason(node) {
  const p = node.parent;
  if (isTrCall(p) && p.arguments[0] === node) return 'done';
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p))
    return 'silent';
  if (ts.isLiteralTypeNode(p)) return 'type';
  if (ts.isTaggedTemplateExpression(p)) return 'tagged';
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isEnumMember(p) ||
      ts.isGetAccessor(p)) &&
    p.name === node
  )
    return 'property-name';
  if (ts.isEnumMember(p)) return 'enum';
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return 'element-access';
  if (ts.isBinaryExpression(p)) {
    const k = p.operatorToken.kind;
    if (
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.InKeyword,
      ].includes(k)
    )
      return 'compare';
  }
  if (ts.isCaseClause(p)) return 'case';
  if (ts.isJsxAttribute(p) && ['key', 'className', 'id', 'href', 'src'].includes(p.name.getText()))
    return 'attr';
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const name = p.expression ? calleeName(p) : '';
    const callee = p.expression?.getText() ?? '';
    if (/^console\./.test(callee)) return 'silent';
    if (name === 'RegExp') return 'regexp';
    if (LOOKUP_METHODS.has(name) && p.arguments?.[0] === node) return 'lookup:' + name;
  }
  return null;
}

function processFile(file, report) {
  const abs = path.join(ROOT, file);
  let src = fs.readFileSync(abs, 'utf8');
  if (!CJK.test(src) && !/['"]zh-(CN|Hans-CN)['"]/.test(src)) return false;
  let changed = false;
  let needTr = false;
  let needLocale = false;
  const isShared = file.startsWith('packages/shared/');
  const skipped = new Map();

  for (let round = 0; round < 12; round++) {
    const sf = ts.createSourceFile(
      file,
      src,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const cands = [];
    const add = (node, text, kind) =>
      cands.push({ start: node.getStart(sf), end: node.getEnd(), text, kind });
    const skip = (node, reason, text) => {
      if (reason === 'done' || reason === 'silent') return;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      skipped.set(
        `${line}:${text}`,
        `${file}:${line + 1}\t${reason}\t${text.replace(/\n/g, '\\n').slice(0, 120)}`,
      );
    };

    const visit = (node) => {
      // 合并：只含文本和简单表达式的 JSX 子节点 → 一个 tr 调用
      if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
        const kids = node.children;
        const texts = kids.filter(ts.isJsxText);
        const exprs = kids.filter(ts.isJsxExpression);
        const mergeable =
          exprs.length > 0 &&
          texts.some((t) => CJK.test(t.text)) &&
          kids.every((k) => ts.isJsxText(k) || ts.isJsxExpression(k)) &&
          exprs.every(
            (e) =>
              e.expression &&
              !e.dotDotDotToken &&
              !containsJsx(e.expression) &&
              !hasLooseCjk(e.expression) &&
              !isTrCall(e.expression),
          ) &&
          !texts.some(
            (t) => t.text.includes('&') || t.text.includes('{') || t.text.includes('}'),
          ) &&
          !lineIgnored(sf, node);
        if (mergeable) {
          const parts = [];
          for (const k of kids) {
            if (ts.isJsxText(k)) {
              const c = cleanJsxText(k.text);
              if (c) parts.push(c);
            } else parts.push(k.expression);
          }
          const first = kids.find((k) => !(ts.isJsxText(k) && !cleanJsxText(k.text)));
          const lastKid = [...kids]
            .reverse()
            .find((k) => !(ts.isJsxText(k) && !cleanJsxText(k.text)));
          cands.push({
            start:
              first.getStart(sf) === first.pos
                ? first.pos
                : ts.isJsxText(first)
                  ? first.pos
                  : first.getStart(sf),
            end: lastKid.getEnd(),
            text: `{${buildCall(parts, 'tr', sf)}}`,
            kind: 'jsx-merge',
            node,
          });
          // 子表达式里没有候选，直接看属性
          if (ts.isJsxElement(node)) ts.forEachChild(node.openingElement, visit);
          return;
        }
      }
      if (ts.isJsxText(node) && CJK.test(node.text)) {
        if (lineIgnored(sf, node)) return;
        if (node.text.includes('&') || node.text.includes('{') || node.text.includes('}'))
          return skip(node, 'jsx-entity', node.text.trim());
        const c = cleanJsxText(node.text);
        if (c)
          cands.push({
            start: node.pos,
            end: node.end,
            text: `{tr(${quote(c)})}`,
            kind: 'jsx-text',
          });
        return;
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        // 写死的中文区域 → 跟随界面语言
        if (/^zh-(CN|Hans-CN)$/.test(node.text)) {
          const p = node.parent;
          const loc =
            (ts.isCallExpression(p) &&
              LOCALE_CALLS.has(calleeName(p)) &&
              p.arguments[0] === node) ||
            (ts.isNewExpression(p) &&
              ts.isPropertyAccessExpression(p.expression) &&
              p.expression.expression.getText(sf) === 'Intl' &&
              INTL_CTORS.has(p.expression.name.text) &&
              p.arguments?.[0] === node);
          if (loc) {
            add(node, isShared ? 'locale()' : 'locale()', 'locale');
            needLocale = true;
          }
          return;
        }
        if (!CJK.test(node.text)) return;
        if (lineIgnored(sf, node)) return;
        const r = skipReason(node);
        if (r) return skip(node, r, node.text);
        const call = `tr(${quote(node.text)})`;
        add(node, ts.isJsxAttribute(node.parent) ? `{${call}}` : call, 'string');
        return;
      }
      if (ts.isTemplateExpression(node)) {
        const lits = [node.head, ...node.templateSpans.map((s) => s.literal)];
        if (lits.some((l) => CJK.test(l.text)) && !lineIgnored(sf, node)) {
          const r = skipReason(node);
          if (r) skip(node, r, node.getText(sf));
          else if (!node.templateSpans.some((s) => hasLooseCjk(s.expression))) {
            const parts = [];
            if (node.head.text) parts.push(node.head.text);
            for (const s of node.templateSpans) {
              parts.push(s.expression);
              if (s.literal.text) parts.push(s.literal.text);
            }
            add(node, buildCall(parts, 'tr', sf), 'template');
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    if (!cands.length) {
      for (const v of skipped.values()) report.push(v);
      break;
    }
    // 从后往前替换，跳过重叠的
    cands.sort((a, b) => b.start - a.start);
    let lastStart = Infinity;
    for (const c of cands) {
      if (c.end > lastStart) continue;
      src = src.slice(0, c.start) + c.text + src.slice(c.end);
      lastStart = c.start;
      if (c.kind !== 'locale') needTr = true;
    }
    changed = true;
  }

  if (!changed) return false;
  src = ensureImport(src, file, isShared, needTr, needLocale);
  if (!DRY) fs.writeFileSync(abs, src);
  return true;
}

function ensureImport(src, file, isShared, needTr, needLocale) {
  const names = [];
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const from = isShared ? relShared(file) : '@/lib/i18n';
  let existing = null;
  let lastImportEnd = 0;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      lastImportEnd = st.getEnd();
      if (st.moduleSpecifier.text === from) existing = st;
    }
  }
  const have = new Set();
  if (
    existing?.importClause?.namedBindings &&
    ts.isNamedImports(existing.importClause.namedBindings)
  )
    for (const el of existing.importClause.namedBindings.elements) have.add(el.name.text);
  if (needTr && !have.has('tr')) names.push('tr');
  if (needLocale && !have.has('locale')) names.push('locale');
  if (!names.length) return src;
  if (
    existing?.importClause?.namedBindings &&
    ts.isNamedImports(existing.importClause.namedBindings)
  ) {
    const nb = existing.importClause.namedBindings;
    const all = [...nb.elements.map((e) => e.getText(sf)), ...names].sort();
    return src.slice(0, nb.getStart(sf)) + `{ ${all.join(', ')} }` + src.slice(nb.getEnd());
  }
  const line = `import { ${names.sort().join(', ')} } from '${from}';`;
  if (lastImportEnd) return src.slice(0, lastImportEnd) + '\n' + line + src.slice(lastImportEnd);
  return line + '\n' + src;
}

function relShared(file) {
  const dir = path.posix.dirname(file);
  let rel = path.posix.relative(dir, 'packages/shared/src/i18n');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
) {
  const report = [];
  let n = 0;
  for (const f of lsFiles()) if (processFile(f, report)) n++;
  fs.writeFileSync(path.join(ROOT, 'tools/i18n/skipped.txt'), report.sort().join('\n') + '\n');
  console.log(`changed ${n} files, ${report.length} skipped literals → tools/i18n/skipped.txt`);
}
