import { z } from 'zod';
import {
  GITHUB_MAX_FILE_BYTES,
  GITHUB_MAX_FILES,
  openGithubPullRequest,
  readGithubFile,
} from '../../modules/versioning/github';
import { ALL_ROLES, defineTool, WORKER_ROLES, type ToolDef } from './types';

/**
 * 代码课题：读关联的 GitHub 仓库、把代码改动开成 PR（版本管理线程，API.md §2.17.4）。
 * 项目没关联仓库时调用会返回说明，让 agent 转告成员去设置里关联。
 * 边界：只新建分支 + 开 PR，从不合并、不推已有分支；整文件覆盖，一次 ≤30 个文件、每个 ≤1 MB。
 */
export const githubTools: ToolDef[] = [
  defineTool({
    name: 'github_read_file',
    description:
      '读项目关联的 GitHub 仓库里的一个文件（给目录路径则列出目录）。ref 不给时读设置里的默认分支。' +
      '项目没关联仓库会报错，请转告成员在「设置 → 版本与提案」里关联。',
    roles: ALL_ROLES,
    schema: z.object({
      path: z.string().min(1).max(500).describe('仓库内路径，如 src/train.py；根目录用 "."'),
      ref: z.string().max(200).optional().describe('分支、tag 或 commit'),
    }),
    async run(tc, args) {
      const path = args.path === '.' || args.path === '/' ? '' : args.path.replace(/^\/+/u, '');
      const f = await readGithubFile(tc.ctx, tc.project.id, path, args.ref);
      const max = 60_000;
      return {
        path: f.path || '.',
        ref: f.ref,
        size: f.size,
        text: f.text.length > max ? `${f.text.slice(0, max)}\n…（截断）` : f.text,
      };
    },
  }),

  defineTool({
    name: 'github_open_pr',
    description:
      '把代码改动提交到关联 GitHub 仓库的一个新分支，并对默认分支开 PR，返回 PR 链接。' +
      `每个文件给出完整的新内容（整文件覆盖；content 为 null 表示删除），一次最多 ${GITHUB_MAX_FILES} 个文件、每个 ≤1 MB。` +
      '只开 PR，不会合并；合并由成员在 GitHub 上审阅后决定。改之前先用 github_read_file 读原文件。',
    roles: WORKER_ROLES,
    schema: z.object({
      branch: z
        .string()
        .min(1)
        .max(100)
        .describe('新分支名，如 srh/fix-lr-schedule；已存在会自动加后缀'),
      title: z.string().min(1).max(200),
      body: z.string().max(20_000).default('').describe('PR 说明：改了什么、为什么、怎么验证'),
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(500),
            content: z.string().max(GITHUB_MAX_FILE_BYTES).nullable(),
          }),
        )
        .min(1)
        .max(GITHUB_MAX_FILES),
    }),
    async run(tc, args) {
      await tc.setActivity('在开 GitHub PR');
      const pr = await openGithubPullRequest(tc.ctx, tc.project.id, {
        branch: args.branch,
        title: args.title,
        body: `${args.body}\n\n---\n_由研协的 agent 提交_`.trim(),
        files: args.files,
      });
      return { ok: true, ...pr, note: 'PR 已开，等成员在 GitHub 上审阅合并；回复里附上链接' };
    },
  }),
];
