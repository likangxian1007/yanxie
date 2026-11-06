import { createContext, useContext } from 'react';

/**
 * 富文本编辑器的环境信息，给 NodeView（图片、附件、内嵌文档、提及）用：
 * NodeView 通过 EditorContent 的 portal 渲染在同一棵 React 树里，可以读到这个 context。
 */
export interface RichEnv {
  projectId: string;
  docId: string;
  editable: boolean;
}

export const RichEnvContext = createContext<RichEnv>({
  projectId: '',
  docId: '',
  editable: false,
});

export function useRichEnv(): RichEnv {
  return useContext(RichEnvContext);
}
