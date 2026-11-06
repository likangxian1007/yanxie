import { z } from 'zod';
import { getRow, withDocumentSnapshot } from '../../modules/documents/service';
import {
  compileLatex,
  getCompiledPdf,
  latexCapability,
} from '../../modules/documents/latex/service';
import { collab } from './collab-port';
import { agentAccess } from './viewer';
import { ALL_ROLES, defineTool, ToolError, type ToolDef } from './types';

/**
 * compile_latex：用平台里同一个编译器（Tectonic / latexmk）编译 LaTeX 文档，返回结果、错误和页数。
 * 终验 R2 #5：agent 没有平台内编译工具，只在云电脑上编过，却对导师说「PDF 已验证」，
 * 而平台里打开是 2 个错误、「结果」一节是空的。送审前用它自检，结论以它为准。
 */

/** TeX 日志里的错误：`! …` 行加上紧随的 `l.<行号>` */
export function texErrors(log: string, max = 12): string[] {
  const lines = log.split(/\r?\n/u);
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const l = lines[i]!;
    if (!l.startsWith('! ')) continue;
    const at = lines.slice(i + 1, i + 8).find((x) => /^l\.\d+/u.test(x));
    out.push(at ? `${l.slice(2)}（${at.trim().slice(0, 120)}）` : l.slice(2));
  }
  return out;
}

/** 未定义的引用 / 参考文献、缺失的图片等警告 */
export function texWarnings(log: string, max = 12): string[] {
  const re =
    /(LaTeX Warning: (?:Reference|Citation) [^\n]*undefined[^\n]*|LaTeX Warning: There were undefined references[^\n]*|File `[^']+' not found[^\n]*|Package [^\n]*Warning: [^\n]*(?:not found|undefined)[^\n]*)/gu;
  const seen = new Set<string>();
  for (const m of log.matchAll(re)) {
    seen.add(m[1]!.trim());
    if (seen.size >= max) break;
  }
  return [...seen];
}

/** PDF 页数（数 /Type /Page，不含 /Pages） */
export function pdfPageCount(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/gu)?.length ?? 0;
}

export const latexTools: ToolDef[] = [
  defineTool({
    name: 'compile_latex',
    description:
      '用平台里的 LaTeX 编译器（和用户点「编译」是同一个）编译一份 LaTeX 文档，返回 status（success / error / timeout / rejected）、' +
      '错误列表（带行号）、未定义引用和缺失文件等警告、PDF 页数和日志末尾。' +
      '改完论文、送审之前必须用它编一次；对人说「编译通过」「PDF 已验证」只能以这里的结果为准，云电脑上编过不算。',
    roles: ALL_ROLES,
    enabled: () => Boolean(collab('documents')),
    schema: z.object({
      doc_id: z.string(),
      force: z.boolean().optional().describe('忽略缓存重新编译'),
    }),
    async run(tc, args) {
      await agentAccess(tc, 'document', args.doc_id);
      const row = await getRow(tc.ctx, tc.project.id, args.doc_id);
      if (row.kind !== 'latex') {
        throw new ToolError(`「${row.title}」不是 LaTeX 文档，不能编译`);
      }
      const cap = await latexCapability(tc.ctx);
      if (!cap.available) {
        throw new ToolError(
          `服务器上的 LaTeX 编译器不可用：${cap.reason ?? '原因未知'}。如实告诉用户没能在平台里编译验证。`,
        );
      }
      await tc.setActivity('在编译 LaTeX');
      const res = await withDocumentSnapshot(tc.ctx, row, (doc) =>
        compileLatex(tc.ctx, tc.project.id, args.doc_id, doc, args.force ? { force: true } : {}),
      );
      const pdf = res.pdfId ? getCompiledPdf(tc.ctx, args.doc_id, res.pdfId) : null;
      const errors = texErrors(res.log);
      const warnings = texWarnings(res.log);
      const tail = res.log.split('\n').slice(-25).join('\n');
      return {
        doc_id: args.doc_id,
        status: res.status,
        ok: res.status === 'success',
        pages: pdf ? pdfPageCount(pdf) : 0,
        pdf_bytes: res.pdfBytes,
        errors,
        warnings,
        duration_ms: res.durationMs,
        cached: res.cached,
        log_tail: tail.length > 3000 ? tail.slice(-3000) : tail,
        note:
          res.status === 'success'
            ? warnings.length
              ? '编译成功，但有警告（未定义的引用或缺失的文件会在 PDF 里显示成 ?? 或空白），处理后再送审。'
              : '编译成功。PDF 里图表、表格是否真的出现，仍以你写进源码的内容为准：引用的图片文件必须在工程里。'
            : '编译没有通过（或 PDF 不完整）。修好后再编一次，通过之前不要对人说「已验证」。',
      };
    },
  }),
];
