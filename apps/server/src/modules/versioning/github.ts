import { ApiError } from '@srh/shared';
import type { AppContext } from '../../context';
import { settingsRow } from './settings';

/**
 * 代码课题关联 GitHub 仓库的最小版本（API.md §2.18.3）。
 *
 * 能做的：用项目设置里的访问令牌读仓库文件；agent 把一组整文件改动提交到一个新分支并开 PR。
 * 不做的（边界）：不合并 PR、不推送到已有分支、不做行级补丁（每个文件整体覆盖或删除）、
 * 不同步仓库内容到项目文件、不跑 CI；一次最多 30 个文件、单个文件 1 MB。
 * 合并、review、冲突处理都在 GitHub 上由人完成。
 */
export const GITHUB_MAX_FILES = 30;
export const GITHUB_MAX_FILE_BYTES = 1024 * 1024;

const API_BASE = 'https://api.github.com';

interface Linked {
  repo: string;
  branch: string;
  token: string;
}

export async function linkedRepo(ctx: AppContext, projectId: string): Promise<Linked> {
  const row = await settingsRow(ctx, projectId);
  if (!row?.githubRepo || !row.githubToken) {
    throw new ApiError(
      'conflict',
      '项目还没有关联 GitHub 仓库：请负责人在「设置 → 版本与提案」里填写仓库和访问令牌',
    );
  }
  return { repo: row.githubRepo, branch: row.githubBranch, token: row.githubToken };
}

async function gh<T>(link: Linked, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${link.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'srh-versioning',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ApiError('internal', `连不上 GitHub：${(err as Error).message}`);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { message?: string }).message ?? msg;
    } catch {
      // 非 JSON
    }
    if (res.status === 401)
      throw new ApiError('conflict', 'GitHub 访问令牌无效或已过期，请在设置里更新');
    if (res.status === 404) throw new ApiError('not_found', `GitHub 上找不到：${path}（${msg}）`);
    throw new ApiError('bad_request', `GitHub 返回 ${res.status}：${msg}`, { status: res.status });
  }
  return (await res.json()) as T;
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export async function testGithub(ctx: AppContext, projectId: string) {
  const link = await linkedRepo(ctx, projectId);
  const repo = await gh<{
    full_name: string;
    private: boolean;
    default_branch: string;
    html_url: string;
    permissions?: { push?: boolean };
  }>(link, `/repos/${link.repo}`);
  return {
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
    url: repo.html_url,
    canPush: !!repo.permissions?.push,
  };
}

export async function readGithubFile(
  ctx: AppContext,
  projectId: string,
  path: string,
  ref?: string,
): Promise<{ path: string; ref: string; text: string; size: number }> {
  const link = await linkedRepo(ctx, projectId);
  const r = ref || link.branch;
  const f = await gh<
    { type: string; content?: string; encoding?: string; size: number } | unknown[]
  >(link, `/repos/${link.repo}/contents/${enc(path)}?ref=${encodeURIComponent(r)}`);
  if (Array.isArray(f)) {
    const names = (f as { name: string; type: string }[]).map((x) =>
      x.type === 'dir' ? `${x.name}/` : x.name,
    );
    return { path, ref: r, text: `（目录）\n${names.join('\n')}`, size: 0 };
  }
  if (f.type !== 'file' || f.encoding !== 'base64' || f.content === undefined) {
    throw new ApiError('validation_failed', `${path} 不是普通文件，或超过 1 MB 无法通过接口读取`);
  }
  return { path, ref: r, text: Buffer.from(f.content, 'base64').toString('utf8'), size: f.size };
}

export interface GithubFileChange {
  path: string;
  /** null = 删除这个文件 */
  content: string | null;
}

export async function openGithubPullRequest(
  ctx: AppContext,
  projectId: string,
  input: { branch: string; title: string; body: string; files: GithubFileChange[] },
): Promise<{ url: string; number: number; branch: string; base: string }> {
  const link = await linkedRepo(ctx, projectId);
  if (!input.files.length) throw new ApiError('validation_failed', '至少改一个文件');
  if (input.files.length > GITHUB_MAX_FILES) {
    throw new ApiError('validation_failed', `一次最多改 ${GITHUB_MAX_FILES} 个文件`);
  }
  for (const f of input.files) {
    if (!/^[^/].*[^/]$/u.test(f.path) || f.path.includes('..')) {
      throw new ApiError('validation_failed', `文件路径不对：${f.path}`);
    }
    if (f.content !== null && Buffer.byteLength(f.content, 'utf8') > GITHUB_MAX_FILE_BYTES) {
      throw new ApiError('validation_failed', `${f.path} 超过 1 MB`);
    }
  }
  const base = link.branch;
  const R = `/repos/${link.repo}`;
  const head = await gh<{ object: { sha: string } }>(link, `${R}/git/ref/heads/${enc(base)}`);
  const commit = await gh<{ tree: { sha: string } }>(link, `${R}/git/commits/${head.object.sha}`);
  const tree = [];
  for (const f of input.files) {
    if (f.content === null) {
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await gh<{ sha: string }>(link, `${R}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh<{ sha: string }>(link, `${R}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: commit.tree.sha, tree }),
  });
  const newCommit = await gh<{ sha: string }>(link, `${R}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: input.title, tree: newTree.sha, parents: [head.object.sha] }),
  });
  // 分支名已被占用时加后缀（只建新分支，绝不改动已有分支）
  const wanted =
    input.branch.replace(/[^A-Za-z0-9._/-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'srh-change';
  let branch = wanted;
  for (let n = 2; ; n += 1) {
    try {
      await gh(link, `${R}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }),
      });
      break;
    } catch (err) {
      if (
        n > 6 ||
        !(err instanceof ApiError) ||
        (err.details as { status?: number })?.status !== 422
      ) {
        throw err;
      }
      branch = `${wanted}-${n}`;
    }
  }
  const pr = await gh<{ html_url: string; number: number }>(link, `${R}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: input.title, body: input.body, head: branch, base }),
  });
  return { url: pr.html_url, number: pr.number, branch, base };
}
