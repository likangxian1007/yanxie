import type * as Y from 'yjs';

/**
 * 导入器的公共约定（import-shell 与各类型导入器共用，见 registry.ts）：
 * 导入器拿到一个**空的**本地 Y.Doc，把文件内容写进对应类型的 Y 结构，返回建议标题；
 * 文件里的图片 / 媒体用 ctx.uploadFile 传到项目文件夹，在文档里按 id / url 引用。
 * 外壳随后把整份 Y.Doc 状态发给服务端（POST P/docs/import），和文档一起原子建好。
 */
export type ImportContext = {
  projectId: string;
  uploadFile: (blob: Blob, name: string) => Promise<{ id: string; url: string }>;
};

/** 导入结果：title 是从文件内容里读到的标题；warnings 是没能导入的部分（给用户看的中文） */
export type ImportResult = { title: string; warnings?: string[] };

export type Importer = (file: File, ydoc: Y.Doc, ctx?: ImportContext) => Promise<ImportResult>;

/** 导入器抛出这个错误时，message 直接展示给用户 */
export class ImportError extends Error {
  override readonly name = 'ImportError';
}
