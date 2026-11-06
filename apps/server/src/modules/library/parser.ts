import type { AppConfig } from '../../config';
import { parseTei, type TeiResult } from './tei';

/**
 * 可插拔的版面解析器（PAPER_PARSER）：
 * - grobid（默认）：GROBID CRF 镜像，CPU 即可，约 1.5–2 GB 内存；返回 TEI（带坐标）
 * - mineru：MinerU 服务（MINERU_URL），需要 GPU。**只预留了接口，未接入**——选了它会报错并降级为纯文本
 * 两者都失败时由流水线降级为逐页纯文本（pdftext.ts）。
 */
export interface LayoutParser {
  readonly name: 'grobid' | 'mineru';
  readonly url: string;
  /** 服务是否可达，及版本 */
  probe(): Promise<{ reachable: boolean; version: string | null }>;
  parse(pdf: Buffer, signal?: AbortSignal): Promise<TeiResult>;
}

export class ParserUnavailable extends Error {}

/** GROBID 需要坐标的元素（前端高亮、裁图、跳转都靠它） */
const TEI_COORDS = ['p', 'head', 'figure', 'formula', 'ref', 'biblStruct', 's'];

export function grobidParser(config: AppConfig): LayoutParser {
  const base = config.GROBID_URL.replace(/\/+$/u, '');
  return {
    name: 'grobid',
    url: base,
    async probe() {
      try {
        const alive = await fetch(`${base}/api/isalive`, { signal: AbortSignal.timeout(3000) });
        // HTTP 200 也可能返回 false（尚未就绪）或代理的 HTML 页面。
        if (!alive.ok || (await alive.text()).trim() !== 'true')
          return { reachable: false, version: null };
        const v = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(3000) })
          .then((r) => (r.ok ? r.text() : ''))
          .catch(() => '');
        let version: string | null = null;
        try {
          version = (JSON.parse(v) as { version?: string }).version ?? null;
        } catch {
          version = v.trim() || null;
        }
        return { reachable: true, version };
      } catch {
        return { reachable: false, version: null };
      }
    },
    async parse(pdf, signal) {
      const form = new FormData();
      form.append(
        'input',
        new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }),
        'paper.pdf',
      );
      form.append('consolidateHeader', '0');
      form.append('consolidateCitations', '0');
      form.append('includeRawCitations', '1');
      form.append('segmentSentences', '0');
      for (const t of TEI_COORDS) form.append('teiCoordinates', t);
      const timeout = AbortSignal.timeout(config.PAPER_PARSE_TIMEOUT_SEC * 1000);
      let res: Response;
      try {
        res = await fetch(`${base}/api/processFulltextDocument`, {
          method: 'POST',
          body: form,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { accept: 'application/xml' },
        });
      } catch (err) {
        const name = (err as Error).name;
        if (name === 'TimeoutError') {
          throw new Error(`GROBID 解析超时（${config.PAPER_PARSE_TIMEOUT_SEC} 秒）`, {
            cause: err,
          });
        }
        throw new ParserUnavailable(`GROBID 不可达（${base}）`, { cause: err });
      }
      // 503 = GROBID 线程池满（并发超过 concurrency），稍后重试
      if (res.status === 503) throw new Error('GROBID 忙，稍后重试');
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`GROBID 返回 HTTP ${res.status}${body ? `：${body}` : ''}`);
      }
      return parseTei(await res.text());
    },
  };
}

export function mineruParser(config: AppConfig): LayoutParser {
  return {
    name: 'mineru',
    url: config.MINERU_URL,
    probe() {
      return Promise.resolve({ reachable: false, version: null });
    },
    parse() {
      return Promise.reject(
        new ParserUnavailable('MinerU 解析器还没有接入（PAPER_PARSER=mineru 只是预留），已降级'),
      );
    },
  };
}

export function createParser(config: AppConfig): LayoutParser {
  return config.PAPER_PARSER === 'mineru' ? mineruParser(config) : grobidParser(config);
}
