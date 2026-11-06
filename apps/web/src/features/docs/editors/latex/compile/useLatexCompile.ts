import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { LatexCapability, LatexCompileResult } from '@srh/shared';
import { ApiRequestError } from '@/lib/api';
import { fetchPdf, requestCompile, useLatexCapability } from './api';
import { parseTexLog, withFailureIssue, type TexIssue } from './texLog';
import { tr } from '@/lib/i18n';

export const AUTO_COMPILE_KEY = 'srh:latex:auto-compile';
export const AUTO_COMPILE_IDLE_MS = 2500;
const SYNC_WAIT_MS = 4000;

function readAuto(): boolean {
  try {
    return window.localStorage.getItem(AUTO_COMPILE_KEY) !== '0';
  } catch {
    return true;
  }
}

export interface LatexCompileState {
  capability: LatexCapability | null;
  /** 能力探测还没返回 */
  probing: boolean;
  available: boolean;
  compiling: boolean;
  result: LatexCompileResult | null;
  pdf: Uint8Array | null;
  /** 请求本身失败（网络、限流…），和 TeX 报错不同 */
  error: string | null;
  issues: TexIssue[];
  /** 最近一次编译之后又有改动 */
  stale: boolean;
  auto: boolean;
  setAuto: (v: boolean) => void;
  compile: (opts?: { force?: boolean }) => Promise<void>;
}

/** 等本地修改被服务端确认（服务端从它那份 Y.Doc 编译），最多等 SYNC_WAIT_MS */
async function waitSynced(provider: HocuspocusProvider | undefined): Promise<void> {
  if (!provider) return;
  const started = Date.now();
  while (
    (provider as { unsyncedChanges?: number }).unsyncedChanges &&
    Date.now() - started < SYNC_WAIT_MS
  ) {
    await new Promise((r) => window.setTimeout(r, 80));
  }
}

/**
 * LaTeX 编译状态：按需编译（按钮 / Ctrl+S）、停止输入后自动编译（可关）、取 PDF、解析日志。
 * enabled = PDF 视图可见；不可见时不自动编译。
 */
export function useLatexCompile(opts: {
  projectId: string;
  docId: string;
  doc: Y.Doc;
  provider: HocuspocusProvider | undefined;
  projectFiles: readonly string[];
  enabled: boolean;
}): LatexCompileState {
  const { projectId, docId, doc, provider, projectFiles, enabled } = opts;
  const cap = useLatexCapability(projectId);
  const capability = cap.data ?? null;
  const available = !!capability?.available;

  const [compiling, setCompiling] = useState(false);
  const [result, setResult] = useState<LatexCompileResult | null>(null);
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(true);
  const [auto, setAutoState] = useState(readAuto);
  const abortRef = useRef<AbortController | null>(null);
  const pdfIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const againRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const setAuto = useCallback((v: boolean) => {
    setAutoState(v);
    try {
      window.localStorage.setItem(AUTO_COMPILE_KEY, v ? '1' : '0');
    } catch {
      // 忽略
    }
  }, []);

  const compile = useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      if (!available) return;
      // 正在编译：结束后再来一次（中途的改动不会丢）
      if (runningRef.current) {
        againRef.current = true;
        return;
      }
      runningRef.current = true;
      setCompiling(true);
      setError(null);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await waitSynced(provider);
        setStale(false);
        const r = await requestCompile(projectId, docId, force, ctrl.signal);
        let nextPdf: Uint8Array | null | undefined;
        if (r.pdfId && r.pdfId !== pdfIdRef.current) {
          nextPdf = await fetchPdf(projectId, docId, r.pdfId, ctrl.signal);
        }
        if (!mountedRef.current) return;
        setResult(r);
        if (nextPdf) {
          pdfIdRef.current = r.pdfId;
          setPdf(nextPdf);
        }
      } catch (err) {
        if (!mountedRef.current || (err instanceof DOMException && err.name === 'AbortError'))
          return;
        setStale(true);
        setError(
          err instanceof ApiRequestError || err instanceof Error ? err.message : tr('编译失败'),
        );
      } finally {
        runningRef.current = false;
        if (mountedRef.current) setCompiling(false);
        if (againRef.current && mountedRef.current) {
          againRef.current = false;
          window.setTimeout(() => void compileRef.current(), 0);
        }
      }
    },
    [available, provider, projectId, docId],
  );
  const compileRef = useRef(compile);
  useEffect(() => {
    compileRef.current = compile;
  }, [compile]);

  // 文档有改动 → 标记过期；开着自动编译且 PDF 可见时，停止输入一会儿后编译
  const autoRef = useRef({ auto, enabled });
  useEffect(() => {
    autoRef.current = { auto, enabled };
  }, [auto, enabled]);
  useEffect(() => {
    let timer: number | null = null;
    const onUpdate = () => {
      setStale(true);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (autoRef.current.auto && autoRef.current.enabled) void compileRef.current();
      }, AUTO_COMPILE_IDLE_MS);
    };
    doc.on('update', onUpdate);
    return () => {
      doc.off('update', onUpdate);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [doc]);

  // 第一次能看到 PDF 视图时编译一次（服务端有缓存，内容没变不会真的重跑）
  const firstRef = useRef(false);
  useEffect(() => {
    if (!available || !enabled || firstRef.current) return;
    firstRef.current = true;
    void compile();
  }, [available, enabled, compile]);

  const issues = useMemo(
    () =>
      result
        ? withFailureIssue(
            parseTexLog(result.log, { projectFiles }),
            result.status,
            result.log,
            !!result.pdfId,
          )
        : [],
    [result, projectFiles],
  );

  return {
    capability,
    probing: cap.isPending,
    available,
    compiling,
    result,
    pdf,
    error,
    issues,
    stale,
    auto,
    setAuto,
    compile,
  };
}
