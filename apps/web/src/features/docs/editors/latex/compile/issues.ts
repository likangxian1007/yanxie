import type { LatexWarning } from '../render/types';
import type { TexIssue } from './texLog';

/** 问题面板里的一项：来自真编译日志或草稿预览检查 */
export interface LatexIssue {
  source: 'compile' | 'draft';
  severity: 'error' | 'warning' | 'info';
  /** null / main.tex = 主文件 */
  file: string | null;
  line: number | null;
  message: string;
  fixable: boolean;
}

export function fromTexIssue(i: TexIssue): LatexIssue {
  return {
    source: 'compile',
    severity: i.severity,
    file: i.file,
    line: i.line,
    message: i.message,
    fixable: i.fixable,
  };
}

export function fromDraftWarning(w: LatexWarning): LatexIssue {
  return {
    source: 'draft',
    severity: w.severity ?? 'warning',
    file: w.file ?? null,
    line: w.line,
    message: w.message,
    fixable: w.fixable !== false,
  };
}

/**
 * AI 补不出不存在的参考文献、缺失的文件和排版提示：这类问题不提供「让 AI 修复」。
 * （cv2-docs 也加过同样的判断：按文案前缀兜底）
 */
export function isAiFixable(w: LatexIssue): boolean {
  if (w.fixable === false || w.severity === 'info') return false;
  return !w.message.startsWith('找不到参考文献');
}
