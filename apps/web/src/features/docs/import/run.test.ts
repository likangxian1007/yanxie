import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import * as Y from 'yjs';
import type { DocumentMeta, FileObject } from '@srh/shared';
import { ApiRequestError } from '@/lib/api';
import type { ImportDocRequest } from './api';
import { assetPath, importErrorMessage, runImport, type ImportDeps } from './run';
import { ImportError } from './types';
import { createImportController } from './useImportQueue';

const MAIN = '\\documentclass{article}\n\\begin{document}\n中文\n\\end{document}\n';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function projectZip(): File {
  return new File(
    [zipSync({ 'main.tex': strToU8(MAIN), 'figures/a.png': PNG, 'figures/b.png': PNG }).slice()],
    '课题 论文.zip',
  );
}

function meta(over: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id: 'doc_new',
    projectId: 'prj_1',
    parentId: null,
    kind: 'latex',
    title: 't',
    icon: null,
    excerpt: '',
    createdBy: { kind: 'user', id: 'usr_a', name: '张三' },
    updatedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    ...over,
  };
}

function fakeDeps(post: ImportDeps['post']) {
  let n = 0;
  const uploads: string[] = [];
  const removed: string[] = [];
  const deps: Partial<ImportDeps> = {
    upload: vi.fn(async (_pid: string, path: string) => {
      n += 1;
      uploads.push(path);
      return { id: `fil_${n}` } as FileObject;
    }),
    remove: vi.fn(async (_pid: string, id: string) => {
      removed.push(id);
    }),
    post: vi.fn(post),
    sleep: vi.fn(async () => undefined),
  };
  return { deps, uploads, removed };
}

describe('runImport', () => {
  it('成功：标题取文件名，图片传到独立目录，状态完整发给服务端', async () => {
    let sent: ImportDocRequest | null = null;
    const { deps, uploads, removed } = fakeDeps(async (req) => {
      sent = req;
      return meta({ title: req.title });
    });
    const stages: string[] = [];
    const res = await runImport({
      pid: 'prj_1',
      file: projectZip(),
      parentId: 'doc_parent',
      importId: 'imp_abcdefgh12345678',
      onProgress: (p) => stages.push(p.stage),
      deps,
    });
    expect(res.meta.title).toBe('课题 论文');
    expect(uploads.sort()).toEqual([
      'imports/课题 论文-12345678/figures/a.png',
      'imports/课题 论文-12345678/figures/b.png',
    ]);
    expect(removed).toEqual([]);
    expect(stages[0]).toBe('parsing');
    expect(stages).toContain('uploading');
    expect(stages.at(-1)).toBe('saving');
    const req = sent!;
    expect(req).toMatchObject({
      kind: 'latex',
      parentId: 'doc_parent',
      importId: 'imp_abcdefgh12345678',
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, req.state);
    expect(doc.getText('source').toString()).toBe(MAIN);
    expect(doc.getMap('assets').size).toBe(2);
  });

  it('断网 / 5xx 自动重试，沿用同一个幂等键', async () => {
    let calls = 0;
    const ids = new Set<string>();
    const { deps } = fakeDeps(async (req) => {
      calls += 1;
      ids.add(req.importId);
      if (calls === 1)
        throw new ApiRequestError({ status: 0, code: 'network_error', message: '断了' });
      if (calls === 2)
        throw new ApiRequestError({ status: 502, code: 'http_502', message: '网关' });
      return meta();
    });
    await runImport({ pid: 'p', file: projectZip(), importId: 'imp_retry_retry', deps });
    expect(calls).toBe(3);
    expect([...ids]).toEqual(['imp_retry_retry']);
  });

  it('服务端拒绝（422）不重试，并删掉已上传的图片', async () => {
    const { deps, removed } = fakeDeps(async () => {
      throw new ApiRequestError({
        status: 422,
        code: 'validation_failed',
        message: '导入的内容和文档类型不匹配',
      });
    });
    await expect(
      runImport({ pid: 'p', file: projectZip(), importId: 'imp_x_x_x_x', deps }),
    ).rejects.toThrow('导入的内容和文档类型不匹配');
    expect(deps.post).toHaveBeenCalledTimes(1);
    expect(removed.sort()).toEqual(['fil_1', 'fil_2']);
  });

  it('重试用完仍失败：清理素材并抛出', async () => {
    const { deps, removed } = fakeDeps(async () => {
      throw new ApiRequestError({
        status: 0,
        code: 'network_error',
        message: '网络断了，文档还没建好',
      });
    });
    await expect(
      runImport({ pid: 'p', file: projectZip(), importId: 'imp_y_y_y_y', deps }),
    ).rejects.toThrow('网络断了');
    expect(deps.post).toHaveBeenCalledTimes(4);
    expect(removed.length).toBe(2);
  });

  // 解析库按需加载，首次加载在满载时可能要几秒
  it('解析失败（损坏的 .docx）：给出中文原因，不新建文档、不上传', async () => {
    const { deps, uploads } = fakeDeps(async () => meta());
    const err = await runImport({
      pid: 'p',
      file: new File(['这不是一个 Word 文件'], '周报.docx'),
      importId: 'imp_z_z_z_z',
      deps,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toContain('Word');
    expect(deps.post).not.toHaveBeenCalled();
    expect(uploads).toEqual([]);
  }, 30_000);

  it('上传图片时断网：保留网络错误（可重试），不包装成解析失败', async () => {
    const { deps } = fakeDeps(async () => meta());
    deps.upload = vi.fn(async () => {
      throw new ApiRequestError({
        status: 0,
        code: 'network_error',
        message: '网络断了，文件没有上传',
      });
    });
    const err = await runImport({
      pid: 'p',
      file: projectZip(),
      importId: 'imp_up_up_up_up',
      deps,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(deps.post).not.toHaveBeenCalled();
  });

  it('不支持的类型直接拒绝', async () => {
    const { deps } = fakeDeps(async () => meta());
    await expect(
      runImport({ pid: 'p', file: new File(['x'], 'a.exe'), importId: 'imp_q_q_q_q', deps }),
    ).rejects.toThrow(/不支持 \.exe/u);
  });
});

describe('辅助函数', () => {
  it('素材路径去掉非法字符和 ..', () => {
    expect(assetPath('f-1', '../a/b:c?.png')).toBe('imports/f-1/a/b_c_.png');
    expect(assetPath('f', '')).toBe('imports/f/file');
  });

  it('错误信息：英文库错误换成中文', () => {
    expect(importErrorMessage(new Error('Corrupted zip: missing EOCD'))).toContain('文件解析失败');
    expect(importErrorMessage(new Error('表格太大'))).toBe('表格太大');
  });
});

describe('导入队列', () => {
  it('不支持的文件立刻标错且不能重试；失败的可以重试；并发不超过 2', async () => {
    let active = 0;
    let peak = 0;
    let failOnce = true;
    const run = vi.fn(async ({ file }: { file: File; importId: string }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      if (file.name === 'broken.md') throw new ImportError('文件解析失败');
      if (file.name === 'flaky.md' && failOnce) {
        failOnce = false;
        throw new ApiRequestError({ status: 500, code: 'x', message: '服务器出了点问题' });
      }
      return { meta: meta({ id: `doc_${file.name}`, kind: 'doc' }), warnings: [] };
    });
    const c = createImportController({ pid: 'p', run }, null);
    const done: string[] = [];
    c.onDone((it) => done.push(it.meta.id));
    const added = c.add([
      new File(['a'], 'a.md'),
      new File(['b'], 'b.md'),
      new File(['c'], 'flaky.md'),
      new File(['d'], 'bad.exe'),
      new File(['e'], 'broken.md'),
    ]);
    expect(added[3]).toMatchObject({ status: 'error', retryable: false });
    await vi.waitFor(() =>
      expect(c.getItems().filter((i) => i.status === 'done' || i.status === 'error').length).toBe(
        5,
      ),
    );
    // 解析失败不能重试
    expect(c.getItems().find((i) => i.file.name === 'broken.md')).toMatchObject({
      status: 'error',
      retryable: false,
    });
    expect(peak).toBeLessThanOrEqual(2);
    const flaky = c.getItems().find((i) => i.file.name === 'flaky.md')!;
    expect(flaky).toMatchObject({ status: 'error', error: '服务器出了点问题', retryable: true });
    c.retry(flaky.id);
    await vi.waitFor(() =>
      expect(c.getItems().find((i) => i.id === flaky.id)!.status).toBe('done'),
    );
    expect(done.sort()).toEqual(['doc_a.md', 'doc_b.md', 'doc_flaky.md']);
    // 重试沿用同一个幂等键
    const keys = run.mock.calls
      .filter(([o]) => o.file.name === 'flaky.md')
      .map(([o]) => o.importId);
    expect(new Set(keys).size).toBe(1);
  });
});
