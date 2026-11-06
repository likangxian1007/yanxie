import { resolve } from 'node:path';

/**
 * LaTeX 编译的部署配置（环境变量）。
 *
 * 这些变量只在编译功能里用到，为了不改动全局的 config.ts（归后端线程），在这里单独读取：
 *
 *   LATEX_COMPILER        auto（默认：先找 tectonic，再找 latexmk）| tectonic | latexmk | none（关闭编译）
 *   TECTONIC_PATH         tectonic 可执行文件（默认在 PATH 里找 `tectonic`）
 *   LATEXMK_PATH          latexmk 可执行文件（默认 `latexmk`，需要完整的 TeX Live：xelatex + bibtex）
 *   LATEX_CACHE_DIR       tectonic 的宏包缓存目录（默认 <STORAGE_DIR>/../latex-cache；部署时挂持久卷）
 *   LATEX_TIMEOUT_MS      单次编译超时（默认 90000）
 *   LATEX_MAX_CONCURRENCY 同时运行的编译进程数（默认 2）
 *   LATEX_RATE_PER_MIN    每个项目每分钟最多真正运行几次编译（命中缓存不算，默认 20）
 *   LATEX_OFFLINE         1 = 只用缓存里的宏包（tectonic --only-cached），不联网下载
 *   LATEX_SANDBOX         none（默认）| bwrap：用 bubblewrap 把编译器关进只读文件系统 + 独立工作目录
 */
export interface LatexOptions {
  compiler: 'auto' | 'tectonic' | 'latexmk' | 'none';
  tectonicPath: string;
  latexmkPath: string;
  cacheDir: string;
  timeoutMs: number;
  maxConcurrency: number;
  ratePerMinute: number;
  offline: boolean;
  sandbox: 'none' | 'bwrap';
  /** 文本文件总字节数上限 */
  maxSourceBytes: number;
  /** 图片总字节数上限 */
  maxAssetBytes: number;
  maxPdfBytes: number;
  /** 保留的日志字符数 */
  maxLogChars: number;
  /** 内存里缓存的 PDF 总字节数（按文档 LRU 淘汰） */
  pdfCacheBytes: number;
}

function int(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function loadLatexOptions(
  storageDir: string,
  env: NodeJS.ProcessEnv = process.env,
): LatexOptions {
  const compilerRaw = (env.LATEX_COMPILER ?? '').trim().toLowerCase();
  const compiler =
    compilerRaw === 'tectonic' || compilerRaw === 'latexmk' || compilerRaw === 'none'
      ? compilerRaw
      : 'auto';
  return {
    compiler,
    tectonicPath: env.TECTONIC_PATH?.trim() || 'tectonic',
    latexmkPath: env.LATEXMK_PATH?.trim() || 'latexmk',
    cacheDir: env.LATEX_CACHE_DIR?.trim() || resolve(storageDir, '..', 'latex-cache'),
    timeoutMs: int(env.LATEX_TIMEOUT_MS, 90_000, 5_000, 600_000),
    maxConcurrency: int(env.LATEX_MAX_CONCURRENCY, 2, 1, 16),
    ratePerMinute: int(env.LATEX_RATE_PER_MIN, 20, 1, 1000),
    offline: ['1', 'true', 'yes', 'on'].includes((env.LATEX_OFFLINE ?? '').toLowerCase()),
    sandbox: (env.LATEX_SANDBOX ?? '').trim().toLowerCase() === 'bwrap' ? 'bwrap' : 'none',
    maxSourceBytes: 4 * 1024 * 1024,
    maxAssetBytes: 60 * 1024 * 1024,
    maxPdfBytes: 50 * 1024 * 1024,
    maxLogChars: 800_000,
    pdfCacheBytes: 256 * 1024 * 1024,
  };
}
