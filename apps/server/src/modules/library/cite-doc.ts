import * as Y from 'yjs';
import {
  ApiError,
  LATEX_LIMITS,
  latexFileKind,
  type ActorRef,
  type LibraryCiteToDocResult,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { withLiveDocument } from '../../realtime/collab';
import { latexFilesMap } from '../documents/latex/project';
import { getRow } from '../documents/service';
import type { Viewer } from '../sharing/access';
import { bibKeysIn } from './bibtex';
import { bibOf, listByIds } from './service';

/**
 * “插入引用”：把论文的 BibTeX 合并进 LaTeX 文档工程里的 .bib（默认 references.bib，没有就新建），
 * 已有的键不重复写；返回 \cite{…} 让编辑器插到光标处。
 * 只通过 documents 模块公开的函数（getRow、latexFilesMap、withLiveDocument）操作，不改 docs 目录。
 */
export async function citeToDocument(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: { docId: string; paperIds: string[]; bibFile: string },
  /** 只能引用这个人看得到的论文（个人 / 团队空间） */
  viewer?: Viewer,
): Promise<LibraryCiteToDocResult> {
  const doc = await getRow(ctx, projectId, input.docId);
  if (doc.kind !== 'latex') throw new ApiError('bad_request', '只能插入到 LaTeX 文档');
  if (doc.archivedAt) throw new ApiError('conflict', '文档已归档，恢复后才能修改');
  if (latexFileKind(input.bibFile) !== 'text' || !input.bibFile.endsWith('.bib')) {
    throw new ApiError('validation_failed', `不是合法的 .bib 路径：${input.bibFile}`);
  }
  const rows = await listByIds(ctx, projectId, input.paperIds, viewer);
  const order = new Map(input.paperIds.map((id, i) => [id, i]));
  rows.sort(
    (a, b) =>
      (order.get(a.id) ?? order.get(a.citekey) ?? 0) -
      (order.get(b.id) ?? order.get(b.citekey) ?? 0),
  );
  const keys = rows.map((r) => r.citekey);
  let added = 0;
  await withLiveDocument(ctx, input.docId, actor, (ydoc) => {
    const files = latexFilesMap(ydoc);
    let text = files.get(input.bibFile);
    if (!(text instanceof Y.Text)) {
      if (files.size >= LATEX_LIMITS.files) {
        throw new ApiError('conflict', `工程文件已达上限（${LATEX_LIMITS.files} 个）`);
      }
      text = new Y.Text();
      files.set(input.bibFile, text);
    }
    const have = bibKeysIn(text.toString());
    let append = '';
    for (const r of rows) {
      if (have.has(r.citekey)) continue;
      append += `\n${bibOf(r)}`;
      have.add(r.citekey);
      added += 1;
    }
    if (!append) return;
    if (text.length + append.length > LATEX_LIMITS.textChars) {
      throw new ApiError('conflict', `${input.bibFile} 太长了，无法再追加`);
    }
    const prefix = text.length && !text.toString().endsWith('\n') ? '\n' : '';
    text.insert(text.length, `${prefix}${append.replace(/^\n/u, text.length ? '\n' : '')}`);
  });
  return {
    docId: input.docId,
    bibFile: input.bibFile,
    keys,
    added,
    cite: `\\cite{${keys.join(',')}}`,
  };
}
