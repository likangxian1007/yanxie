import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  LATEX_YDOC,
  latexFileKind,
  type DocumentContent,
  type DocumentMeta,
  type LatexCapability,
  type LatexCompileResult,
} from '@srh/shared';
import type { AppContext } from '../../src/context';
import { loadLatexOptions } from '../../src/modules/documents/latex/config';
import { findMissingBibs, findUnsafePath } from '../../src/modules/documents/latex/project';
import { tectonicRunner, type LatexRunner } from '../../src/modules/documents/latex/runner';
import {
  countLogErrors,
  MISSING_BIB_NOTE,
  setLatexRunner,
} from '../../src/modules/documents/latex/service';
import { writeProjectFile } from '../../src/modules/files/service';
import { withLiveDocument } from '../../src/realtime/collab';
import { setupCollabApp, type CollabTestApp } from './helpers';

const PID = 'prj_latex';
const base = `/api/v1/projects/${PID}`;
const ACTOR = { kind: 'user' as const, id: 'usr_a', name: '张三' };

let t: CollabTestApp;
let ctx: AppContext;

const PAPER = String.raw`\documentclass{article}
\begin{document}
Hello \cite{he2016}.
\bibliographystyle{plain}
\bibliography{references}
\end{document}
`;
const BIB = `@article{he2016,
  author = {Kaiming He},
  title = {Deep Residual Learning},
  year = {2016}
}
`;

/** 假编译器：记录调用，按 behave 写出 main.pdf / main.log */
interface FakeCall {
  files: Record<string, string>;
}
function fakeRunner(
  behave: (dir: string) => Promise<{ exitCode?: number; timedOut?: boolean; output?: string }>,
): LatexRunner & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    engine: 'tectonic',
    calls,
    probe: async () => ({ ok: true, version: 'Tectonic 0.0.0-test' }),
    async run({ dir }) {
      const files: Record<string, string> = {};
      for (const name of ['main.tex', 'references.bib', 'sections/intro.tex']) {
        try {
          files[name] = await readFile(join(dir, name), 'utf8');
        } catch {
          // 不存在
        }
      }
      calls.push({ files });
      const r = await behave(dir);
      return { exitCode: r.exitCode ?? 0, timedOut: r.timedOut ?? false, output: r.output ?? '' };
    },
  };
}

const okPdf = async (dir: string) => {
  await writeFile(join(dir, 'main.pdf'), '%PDF-1.5\n% fake\n');
  await writeFile(
    join(dir, 'main.log'),
    'This is XeTeX\n(main.tex\nOutput written on main.xdv (1 page).\n',
  );
  await writeFile(join(dir, 'main.blg'), 'Database file #1: references.bib\n');
  return { output: 'note: Running BibTeX on main.aux ...' };
};

beforeAll(async () => {
  t = await setupCollabApp();
  ctx = (t.app as unknown as { ctx: AppContext }).ctx;
  await t.seedUser('usr_a', '张三', 1);
  await t.seedUser('usr_g', '访客', 3);
  await t.seedUser('usr_x', '外人', 4);
  await t.seedProject(PID, 'usr_a');
  await t.addMember(PID, 'usr_g', 'guest');
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function createLatex(markdown = PAPER, bib: string | null = BIB): Promise<DocumentMeta> {
  const res = await t.app.inject({
    method: 'POST',
    url: `${base}/docs`,
    headers: t.as('usr_a'),
    payload: { title: '论文', kind: 'latex', markdown },
  });
  expect(res.statusCode).toBe(201);
  const meta = res.json<DocumentMeta>();
  if (bib !== null) {
    await withLiveDocument(ctx, meta.id, ACTOR, (doc) => {
      const text = new Y.Text();
      text.insert(0, bib);
      doc.getMap<Y.Text>(LATEX_YDOC.files).set('references.bib', text);
    });
  }
  return meta;
}

function compile(docId: string, user = 'usr_a', payload: Record<string, unknown> = {}) {
  return t.app.inject({
    method: 'POST',
    url: `${base}/docs/${docId}/latex/compile`,
    headers: t.as(user),
    payload,
  });
}

describe('LaTeX 编译端点（假编译器）', () => {
  let runner: ReturnType<typeof fakeRunner>;
  beforeEach(() => {
    runner = fakeRunner(okPdf);
    setLatexRunner(ctx, runner);
  });

  it('capability 报告可用与限制；关闭编译时不可用且编译返回 501', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/latex/capability`,
      headers: t.as('usr_g'),
    });
    expect(res.statusCode).toBe(200);
    const cap = res.json<LatexCapability>();
    expect(cap).toMatchObject({ available: true, engine: 'tectonic', reason: null });
    expect(cap.limits.timeoutMs).toBeGreaterThan(0);

    setLatexRunner(ctx, null);
    const off = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/latex/capability`,
      headers: t.as('usr_a'),
    });
    expect(off.json<LatexCapability>()).toMatchObject({ available: false, engine: null });
    const meta = await createLatex();
    const c = await compile(meta.id);
    expect(c.statusCode).toBe(501);
  });

  it('把 main.tex 和 references.bib 写进工作目录，返回 PDF，可按 pdfId 下载', async () => {
    const meta = await createLatex();
    const res = await compile(meta.id);
    expect(res.statusCode).toBe(200);
    const r = res.json<LatexCompileResult>();
    expect(r).toMatchObject({ status: 'success', cached: false, engine: 'tectonic' });
    expect(r.pdfId).toBeTruthy();
    expect(r.log).toContain('BibTeX');
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.files['main.tex']).toContain('\\cite{he2016}');
    expect(runner.calls[0]!.files['references.bib']).toContain('he2016');

    const pdf = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${meta.id}/latex/pdf/${r.pdfId}?download=1`,
      headers: t.as('usr_g'),
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(String(pdf.headers['content-disposition'])).toMatch(/^attachment;/u);
    expect(pdf.body.startsWith('%PDF-')).toBe(true);

    const stale = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${meta.id}/latex/pdf/deadbeef`,
      headers: t.as('usr_a'),
    });
    expect(stale.statusCode).toBe(404);
  });

  it('输入没变时复用结果，force 时重新编译，改了 .bib 也会重新编译', async () => {
    const meta = await createLatex();
    expect((await compile(meta.id)).json<LatexCompileResult>().cached).toBe(false);
    expect((await compile(meta.id)).json<LatexCompileResult>().cached).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(
      (await compile(meta.id, 'usr_a', { force: true })).json<LatexCompileResult>().cached,
    ).toBe(false);
    expect(runner.calls).toHaveLength(2);
    await withLiveDocument(ctx, meta.id, ACTOR, (doc) => {
      doc.getMap<Y.Text>(LATEX_YDOC.files).get('references.bib')!.insert(0, '% edited\n');
    });
    expect((await compile(meta.id)).json<LatexCompileResult>().cached).toBe(false);
    expect(runner.calls).toHaveLength(3);
  });

  it('TeX 报错时状态为 error，仍带上部分 PDF；没有 PDF 也算 error', async () => {
    setLatexRunner(
      ctx,
      fakeRunner(async (dir) => {
        await writeFile(join(dir, 'main.pdf'), '%PDF-1.5\n');
        await writeFile(
          join(dir, 'main.log'),
          '(main.tex\n! Undefined control sequence.\nl.5 \\undefinedcmd\n                 {a}\n',
        );
        return { output: 'error: main.tex:5: Undefined control sequence' };
      }),
    );
    const meta = await createLatex();
    const r = (await compile(meta.id)).json<LatexCompileResult>();
    expect(r.status).toBe('error');
    expect(r.pdfId).toBeTruthy();
    expect(r.log).toContain('! Undefined control sequence.');

    setLatexRunner(
      ctx,
      fakeRunner(async (dir) => {
        await writeFile(join(dir, 'main.log'), '(main.tex\nNo pages of output.\n');
        return { exitCode: 1 };
      }),
    );
    const r2 = (await compile(meta.id)).json<LatexCompileResult>();
    expect(r2).toMatchObject({ status: 'error', pdfId: null });
  });

  it('超时映射为 timeout，并提示稍后重试', async () => {
    setLatexRunner(
      ctx,
      fakeRunner(async () => ({ timedOut: true, exitCode: null as unknown as number })),
      { timeoutMs: 5000 },
    );
    const meta = await createLatex();
    const r = (await compile(meta.id)).json<LatexCompileResult>();
    expect(r.status).toBe('timeout');
    expect(r.log).toContain('5 秒被终止');
    // 超时的结果不缓存：再编译会重新运行
    const again = (await compile(meta.id)).json<LatexCompileResult>();
    expect(again.cached).toBe(false);
  });

  it('\\bibliography 引用的 .bib 不在工程里：照常编译，日志里说明缺哪个文件、在哪一行、项目文件夹里的同名文件不算', async () => {
    // R2 e2e：agent 用 write_file 把 refs.bib 写进了项目文件夹，LaTeX 工程里只有 main.tex
    await writeProjectFile(ctx, ACTOR, PID, 'outputs/e2e/references.bib', BIB);
    const meta = await createLatex(PAPER, null);
    const r = (await compile(meta.id)).json<LatexCompileResult>();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.files['references.bib']).toBeUndefined();
    expect(r.pdfId).toBeTruthy();
    const note = r.log.split('\n').find((l) => l.startsWith(MISSING_BIB_NOTE));
    expect(note).toBeDefined();
    expect(note).toContain('main.tex 第 5 行 \\bibliography{references} 要用 references.bib');
    expect(note).toContain('outputs/e2e/references.bib 不属于这个 LaTeX 工程');
    expect(note).toContain('[?]');

    // 工程里有对应的 .bib：不提示
    const ok = await createLatex(PAPER.replace('Hello', 'Hi'));
    const r2 = (await compile(ok.id)).json<LatexCompileResult>();
    expect(r2.log).not.toContain(MISSING_BIB_NOTE);
  });

  it('源码超过上限、引用工程外的文件时拒绝，不运行编译器', async () => {
    setLatexRunner(ctx, runner, { maxSourceBytes: 200 });
    const big = await createLatex(`${PAPER}${'%'.repeat(400)}\n`, null);
    const r = (await compile(big.id)).json<LatexCompileResult>();
    expect(r.status).toBe('rejected');
    expect(r.log).toContain('源码太大');

    setLatexRunner(ctx, runner);
    const evil = await createLatex(
      String.raw`\documentclass{article}
\begin{document}
\input{/etc/passwd}
\end{document}`,
      null,
    );
    const r2 = (await compile(evil.id)).json<LatexCompileResult>();
    expect(r2.status).toBe('rejected');
    expect(r2.log).toContain('main.tex:3');
    expect(runner.calls).toHaveLength(0);
  });

  it('权限：访客可以编译，非成员 404；非 LaTeX 文档 400', async () => {
    const meta = await createLatex();
    expect((await compile(meta.id, 'usr_g')).statusCode).toBe(200);
    expect((await compile(meta.id, 'usr_x')).statusCode).toBe(404);
    const doc = await t.app.inject({
      method: 'POST',
      url: `${base}/docs`,
      headers: t.as('usr_a'),
      payload: { title: '普通文档', kind: 'doc' },
    });
    expect((await compile(doc.json<DocumentMeta>().id)).statusCode).toBe(400);
  });

  it('每个项目每分钟的编译次数有上限（命中缓存不计）', async () => {
    setLatexRunner(ctx, runner, { ratePerMinute: 2 });
    const a = await createLatex();
    const b = await createLatex(PAPER.replace('Hello', 'Hi'));
    const c = await createLatex(PAPER.replace('Hello', 'Hey'));
    expect((await compile(a.id)).statusCode).toBe(200);
    expect((await compile(a.id)).statusCode).toBe(200); // 缓存
    expect((await compile(b.id)).statusCode).toBe(200);
    const limited = await compile(c.id);
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
  });

  it('markdown 读取附上工程文件清单与 .bib 条目，结构化编辑仍改 main.tex', async () => {
    const meta = await createLatex();
    const res = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${meta.id}/markdown`,
      headers: t.as('usr_a'),
    });
    const content = res.json<DocumentContent>();
    expect(content.files?.map((f) => [f.name, f.kind])).toEqual([
      ['main.tex', 'main'],
      ['references.bib', 'text'],
    ]);
    expect(content.markdown).toContain('% references.bib（参考文献：he2016）');
    expect(content.markdown).toContain('\\documentclass{article}');

    const edit = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${meta.id}/edit`,
      headers: t.as('usr_a'),
      payload: { op: 'replace_text', find: 'Hello', replace: 'Hi' },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json<{ markdown: string }>().markdown.startsWith('\\documentclass')).toBe(true);

    // 没有辅助文件的 LaTeX 文档：保持原样
    const plain = await createLatex(PAPER, null);
    const p = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${plain.id}/markdown`,
      headers: t.as('usr_a'),
    });
    expect(p.json<DocumentContent>().files).toBeUndefined();
    expect(p.json<DocumentContent>().markdown).toBe(PAPER);
  });

  it('恢复版本时辅助文件也恢复', async () => {
    const meta = await createLatex();
    const v = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${meta.id}/versions`,
      headers: t.as('usr_a'),
      payload: { label: '初稿' },
    });
    await withLiveDocument(ctx, meta.id, ACTOR, (doc) => {
      const files = doc.getMap<Y.Text>(LATEX_YDOC.files);
      files.get('references.bib')!.insert(0, '@misc{x, title={x}}\n');
      const extra = new Y.Text();
      extra.insert(0, 'extra');
      files.set('extra.tex', extra);
    });
    const restore = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${meta.id}/versions/${v.json<{ id: string }>().id}/restore`,
      headers: t.as('usr_a'),
    });
    expect(restore.statusCode).toBe(200);
    const after = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${meta.id}/markdown`,
      headers: t.as('usr_a'),
    });
    expect(after.json<DocumentContent>().files?.map((f) => f.name)).toEqual([
      'main.tex',
      'references.bib',
    ]);
  });
});

describe('纯函数', () => {
  it('工程路径校验', () => {
    expect(latexFileKind('main.tex')).toBe('main');
    expect(latexFileKind('references.bib')).toBe('text');
    expect(latexFileKind('figures/arch.png')).toBe('image');
    expect(latexFileKind('../x.tex')).toBeNull();
    expect(latexFileKind('/abs.tex')).toBeNull();
    expect(latexFileKind('a/../b.tex')).toBeNull();
    expect(latexFileKind('run.sh')).toBeNull();
    expect(latexFileKind('a b.tex')).toBeNull();
  });

  it('不安全路径检测', () => {
    const f = (content: string) => findUnsafePath([{ name: 'main.tex', content }]);
    expect(f('\\input{sections/intro}')).toBeNull();
    expect(f('\\includegraphics[width=3cm]{figures/a.png}')).toBeNull();
    expect(f('% \\input{/etc/passwd}')).toBeNull();
    expect(f('\\input{/etc/passwd}')).not.toBeNull();
    expect(f('\\input{../secret}')).not.toBeNull();
    expect(f('\\openin\\f=C:/Windows/win.ini')).not.toBeNull();
    expect(f('\\includegraphics{~/x.png}')).not.toBeNull();
    expect(f('\\graphicspath{{/abs/}}')).not.toBeNull();
    expect(f('数值 a/b 与 and/or 都没问题')).toBeNull();
  });

  it('缺失的 .bib 检测', () => {
    const f = (content: string, extra: string[] = []) =>
      findMissingBibs([
        { name: 'main.tex', content },
        ...extra.map((name) => ({ name, content: '' })),
      ]).map((m) => [m.line, m.name]);
    expect(f('\\bibliography{refs}')).toEqual([[1, 'refs.bib']]);
    expect(f('\\bibliography{refs}', ['refs.bib'])).toEqual([]);
    expect(f('x\n\\bibliography{refs, ./more.bib}', ['refs.bib'])).toEqual([[2, 'more.bib']]);
    expect(f('\\addbibresource{lib/a.bib}')).toEqual([[1, 'lib/a.bib']]);
    expect(f('% \\bibliography{refs}')).toEqual([]);
    expect(f('\\bibliographystyle{plain}')).toEqual([]);
  });

  it('日志错误计数（两种格式）', () => {
    expect(countLogErrors('! Undefined control sequence.\nl.5 \\x\n')).toBe(1);
    expect(countLogErrors('./main.tex:7: Missing $ inserted.\n')).toBe(1);
    expect(countLogErrors("LaTeX Warning: Citation `x' undefined on input line 4.\n")).toBe(0);
  });

  it('LATEX_* 环境变量解析', () => {
    const o = loadLatexOptions('/data/storage', {
      LATEX_COMPILER: 'TECTONIC',
      LATEX_TIMEOUT_MS: '1',
      LATEX_SANDBOX: 'bwrap',
    });
    expect(o.compiler).toBe('tectonic');
    expect(o.timeoutMs).toBe(5000);
    expect(o.sandbox).toBe('bwrap');
    expect(loadLatexOptions('/x', {}).compiler).toBe('auto');
  });
});

// ---------------------------------------------------------------- 真编译（装了 tectonic 才跑）

const TECTONIC = process.env.TECTONIC_PATH || 'tectonic';
const hasTectonic = (() => {
  try {
    return spawnSync(TECTONIC, ['--version'], { timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTectonic)(
  '真实 tectonic 编译（需要 TECTONIC_PATH 或 PATH 里有 tectonic）',
  () => {
    it('BibTeX 引用编进 PDF', async () => {
      const opts = loadLatexOptions(ctx.config.STORAGE_DIR);
      setLatexRunner(ctx, tectonicRunner({ ...opts, tectonicPath: TECTONIC }), {
        timeoutMs: 600_000,
      });
      const meta = await createLatex();
      const r = (await compile(meta.id)).json<LatexCompileResult>();
      expect(r.status, r.log.slice(-2000)).toBe('success');
      expect(r.pdfBytes).toBeGreaterThan(1000);
      expect(r.log).toMatch(/BibTeX|bibtex/u);
      expect(r.log).not.toContain(MISSING_BIB_NOTE);
    }, 620_000);

    it('工程里没有 .bib：tectonic 照样出 PDF（退出码 0），日志里有缺失说明', async () => {
      const opts = loadLatexOptions(ctx.config.STORAGE_DIR);
      setLatexRunner(ctx, tectonicRunner({ ...opts, tectonicPath: TECTONIC }), {
        timeoutMs: 600_000,
      });
      const meta = await createLatex(PAPER.replace('Hello', 'Missing bib'), null);
      const r = (await compile(meta.id)).json<LatexCompileResult>();
      expect(r.pdfId).toBeTruthy();
      expect(r.log).toContain("I couldn't open database file references.bib");
      expect(r.log).toContain(`${MISSING_BIB_NOTE}：main.tex 第 5 行`);
    }, 620_000);
  },
);
