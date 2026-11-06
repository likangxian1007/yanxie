import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { findConflicts } from '../../modules/claims/service';
import {
  diskPath,
  getFileByPath,
  isTextMime,
  listFiles,
  MAX_FILE_BYTES,
  normalizePath,
  readProjectFileText,
  writeProjectFile,
} from '../../modules/files/service';
import { extractPdf } from '../../websearch/extract';
import { claimViews, requireCoveringClaim } from './collab';
import { ALL_ROLES, defineTool, ToolError, WORKER_ROLES, type ToolDef } from './types';

/**
 * 项目共享文件夹工具：list_files、read_file、write_file。
 * 覆盖已有文件前必须持有覆盖该路径的 file 认领（ARCHITECTURE.md §5.3.6）；新建文件不需要认领，
 * 但目标路径落在别人独占认领的范围（如 data/raw/**）里时同样拒绝。
 */
const LIST_LIMIT = 300;
const DEFAULT_CHARS = 20_000;
const MAX_CHARS = 100_000;

export const fileTools: ToolDef[] = [
  defineTool({
    name: 'list_files',
    description: '列出项目共享文件夹里的文件（路径、大小、类型）。传 dir 只列该目录（含子目录）。',
    roles: ALL_ROLES,
    schema: z.object({ dir: z.string().optional().describe('目录，如 outputs/exp07') }),
    async run(tc, args) {
      const list = await listFiles(tc.ctx, tc.project.id, args.dir);
      return {
        files: list.slice(0, LIST_LIMIT).map((f) => ({
          id: f.id,
          path: f.path,
          size: f.size,
          mime: f.mime,
          updated_at: f.createdAt,
        })),
        ...(list.length > LIST_LIMIT
          ? { note: `共 ${list.length} 个文件，只列出前 ${LIST_LIMIT} 个，用 dir 缩小范围` }
          : {}),
      };
    },
  }),

  defineTool({
    name: 'read_file',
    description:
      '按路径或文件 id 读取项目文件的文本内容（默认最多 20000 字）。PDF 会自动抽取文字（带 [第 N 页] 标记），长文用 start_char 接着 next_start_char 分段读。图片读不出文本，用 view_image 看；其他二进制文件也读不出文本。',
    roles: ALL_ROLES,
    schema: z.object({
      path_or_id: z.string().min(1),
      max_chars: z.number().int().min(100).max(MAX_CHARS).optional(),
      start_char: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('PDF 从第几个字开始读，用上次返回的 next_start_char'),
    }),
    async run(tc, args) {
      const maxChars = args.max_chars ?? DEFAULT_CHARS;
      const { file, text, truncated } = await readProjectFileText(
        tc.ctx,
        tc.project.id,
        args.path_or_id,
        maxChars * 4,
      );
      if (file.mime === 'application/pdf' || /\.pdf$/iu.test(file.path)) {
        if (file.size > MAX_FILE_BYTES) {
          throw new ToolError(`PDF 超过 ${MAX_FILE_BYTES / 1024 / 1024} MB，无法解析`);
        }
        let ex;
        try {
          const bytes = await readFile(diskPath(tc.ctx, tc.project.id, file.path));
          ex = await extractPdf(new Uint8Array(bytes));
        } catch (err) {
          if (err instanceof ToolError) throw err;
          return {
            path: file.path,
            file_id: file.id,
            mime: file.mime,
            text: '',
            truncated: false,
            note: `PDF 解析失败（${(err as Error).message}），可能是扫描件或加密文件。`,
          };
        }
        const start = Math.min(args.start_char ?? 0, ex.text.length);
        const body = ex.text.slice(start, start + maxChars);
        const end = start + body.length;
        return {
          path: file.path,
          file_id: file.id,
          mime: file.mime,
          title: ex.title || undefined,
          pages: ex.pages,
          total_chars: ex.text.length,
          start_char: start,
          text: body,
          truncated: end < ex.text.length,
          ...(end < ex.text.length ? { next_start_char: end } : {}),
          ...(ex.text.trim().length === 0
            ? { note: 'PDF 没有可提取的文字层（可能是扫描件）。' }
            : {}),
        };
      }
      if (!isTextMime(file.mime)) {
        const image = file.mime.startsWith('image/');
        return {
          path: file.path,
          file_id: file.id,
          mime: file.mime,
          text: '',
          truncated: false,
          note: image
            ? `这是图片（${file.mime}），read_file 读不出内容。用 view_image(path_or_id="${file.id}") 查看，可带上 question 说明你想从图里知道什么。`
            : `这是二进制文件（${file.mime}），不能以文本读取。`,
        };
      }
      const cut = text.length > maxChars;
      return {
        path: file.path,
        file_id: file.id,
        text: cut ? text.slice(0, maxChars) : text,
        truncated: truncated || cut,
      };
    },
  }),

  defineTool({
    name: 'write_file',
    description:
      '把文本写进项目共享文件夹（脚本、表格、导出）。新文件放在 outputs/<线程短名>/（个人会话放 drafts/<主人短名>/）下，不需要认领；' +
      '覆盖已有文件前必须先认领该路径（claim resource_kind=file），否则被拒。',
    roles: WORKER_ROLES,
    schema: z.object({
      path: z
        .string()
        .min(1)
        .max(300)
        .describe('项目内相对路径，如 outputs/exp07-analysis/ttest.py'),
      content: z.string().max(2_000_000),
    }),
    async run(tc, args) {
      const path = normalizePath(args.path);
      const existing = await getFileByPath(tc.ctx, tc.project.id, path);
      if (existing) {
        await requireCoveringClaim(
          tc,
          { resourceKind: 'file', resourceRef: path },
          { label: `文件 ${path}（已存在，写入会覆盖）`, suggestMode: 'exclusive' },
        );
      } else {
        const conflicts = await findConflicts(
          tc.ctx,
          tc.project.id,
          [{ resourceKind: 'file', resourceRef: path, mode: 'shared' }],
          { holderId: tc.session.id, threadId: tc.thread?.id ?? null },
        );
        const others = conflicts.flatMap((c) => c.conflictsWith);
        if (others.length > 0) {
          throw new ToolError(
            `路径 ${path} 落在 ${others[0]!.holder.name} 独占认领的范围里，不能写。换个路径（如 outputs/<线程短名>/）或等对方释放`,
            { code: 'claim_conflict', claims: await claimViews(tc, others) },
          );
        }
      }
      const { file, created } = await writeProjectFile(
        tc.ctx,
        tc.actor,
        tc.project.id,
        path,
        args.content,
      );
      return {
        ok: true,
        file_id: file.id,
        path: file.path,
        created,
        size: file.size,
        link: `[${file.name}](${file.path})`,
      };
    },
  }),
];
