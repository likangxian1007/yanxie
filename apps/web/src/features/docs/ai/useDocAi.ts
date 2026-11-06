import { useCallback, useRef, useState } from 'react';
import type { DocumentAiInput } from '@srh/shared';
import { ApiRequestError, resolveApiUrl } from '@/lib/api';
import { tr } from '@/lib/i18n';

/**
 * 文档内嵌 AI：POST P/docs/:docId/ai，服务端用 DeepSeek 流式返回纯文本（text/plain 分块）。
 * 四类编辑器共用：拿到 text 后由编辑器决定插入 / 替换选区 / 写单元格 / 生成幻灯片。
 */
export type DocAiStatus = 'idle' | 'streaming' | 'done' | 'error';

export interface DocAiState {
  status: DocAiStatus;
  text: string;
  error: string | null;
}

export function useDocAi(projectId: string, docId: string) {
  const [state, setState] = useState<DocAiState>({ status: 'idle', text: '', error: null });
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (input: DocumentAiInput, onChunk?: (chunk: string, full: string) => void) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setState({ status: 'streaming', text: '', error: null });
      let full = '';
      try {
        const res = await fetch(resolveApiUrl(`/projects/${projectId}/docs/${docId}/ai`), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
          body: JSON.stringify(input),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          let message = tr('AI 暂时不可用，请稍后再试。');
          try {
            const body = (await res.json()) as { error?: { message?: string } };
            if (body.error?.message) message = body.error.message;
          } catch {
            // 非 JSON 错误体：用兜底文案
          }
          throw new ApiRequestError({ status: res.status, code: `http_${res.status}`, message });
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (!chunk) continue;
          full += chunk;
          onChunk?.(chunk, full);
          setState({ status: 'streaming', text: full, error: null });
        }
        setState({ status: 'done', text: full, error: null });
        return full;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setState((s) => ({ ...s, status: 'done' }));
          return full;
        }
        const message =
          err instanceof ApiRequestError
            ? err.message
            : tr('网络中断了，AI 没有写完。可以重试一次。');
        setState({ status: 'error', text: full, error: message });
        return null;
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [projectId, docId],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => setState({ status: 'idle', text: '', error: null }), []);

  return { ...state, run, stop, reset };
}

/** 动作的中文名（菜单、状态行用） */
export const AI_ACTION_LABEL: Record<DocumentAiInput['action'], string> = {
  continue: tr('续写'),
  polish: tr('润色'),
  shorten: tr('精简'),
  expand: tr('扩写'),
  translate_en: tr('译成英文'),
  translate_zh: tr('译成中文'),
  summarize: tr('总结'),
  academic: tr('改成学术语气'),
  custom: tr('按指令修改'),
  outline: tr('生成大纲'),
  table: tr('生成表格'),
  slides: tr('生成幻灯片'),
  latex_fix: tr('修复 LaTeX'),
  latex_section: tr('写一个小节'),
};
