/** 导入用的小工具：文本解码、文件名 */

/**
 * 字节 → 文本：认 UTF-8 / UTF-16 BOM；不是合法 UTF-8 时按 GB18030 解（老的中文 .tex / .txt
 * 常是 GBK）；统一换行为 \n。
 */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes);
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes);
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try {
        text = new TextDecoder('gb18030').decode(bytes);
      } catch {
        text = new TextDecoder('utf-8').decode(bytes);
      }
    }
  }
  return text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
}

/** 扩展名（小写，不带点）；没有返回 '' */
export function fileExt(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 去掉扩展名的文件名，作为文档标题（最多 120 字） */
export function fileBaseName(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? name;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  return stem.slice(0, 120);
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
