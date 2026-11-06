import { tr } from '@/lib/i18n';
/**
 * 斜杠菜单的命令清单与过滤（纯数据 + 纯函数；图标和执行逻辑在组件 / commands.ts 里）。
 */
export type SlashItemId =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock'
  | 'table'
  | 'blockMath'
  | 'inlineMath'
  | 'divider'
  | 'image'
  | 'attachment'
  | 'mention'
  | 'embedSheet'
  | 'embedSlides'
  | 'embedDoc'
  | 'newSheet'
  | 'aiContinue'
  | 'aiOutline'
  | 'aiSummarize';

export type SlashGroup = 'basic' | 'insert' | 'embed' | 'ai';

export interface SlashItem {
  id: SlashItemId;
  label: string;
  description: string;
  group: SlashGroup;
  /** 中英文关键词（小写） */
  keywords: string[];
}

export const SLASH_GROUP_LABEL: Record<SlashGroup, string> = {
  basic: tr('基础'),
  insert: tr('插入'),
  embed: tr('嵌入'),
  ai: 'AI',
};

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'paragraph',
    label: tr('文本'),
    description: tr('普通段落'),
    group: 'basic',
    keywords: ['text', 'paragraph', 'p', tr('正文'), tr('段落')],
  },
  {
    id: 'h1',
    label: tr('标题 1'),
    description: tr('大标题'),
    group: 'basic',
    keywords: ['h1', 'heading', 'title', tr('标题'), tr('一级标题')],
  },
  {
    id: 'h2',
    label: tr('标题 2'),
    description: tr('中标题'),
    group: 'basic',
    keywords: ['h2', 'heading', 'subtitle', tr('标题'), tr('二级标题')],
  },
  {
    id: 'h3',
    label: tr('标题 3'),
    description: tr('小标题'),
    group: 'basic',
    keywords: ['h3', 'heading', tr('标题'), tr('三级标题')],
  },
  {
    id: 'bulletList',
    label: tr('无序列表'),
    description: tr('圆点列表'),
    group: 'basic',
    keywords: ['ul', 'bullet', 'list', 'unordered', tr('列表'), tr('项目符号')],
  },
  {
    id: 'orderedList',
    label: tr('有序列表'),
    description: tr('编号列表'),
    group: 'basic',
    keywords: ['ol', 'ordered', 'number', 'list', tr('列表'), tr('编号'), tr('数字')],
  },
  {
    id: 'taskList',
    label: tr('待办'),
    description: tr('可勾选的任务列表'),
    group: 'basic',
    keywords: [
      'todo',
      'task',
      'checkbox',
      'check',
      tr('任务'),
      tr('待办'),
      tr('清单'),
      tr('复选框'),
    ],
  },
  {
    id: 'blockquote',
    label: tr('引用'),
    description: tr('引用一段话'),
    group: 'basic',
    keywords: ['quote', 'blockquote', tr('引用'), tr('引文')],
  },
  {
    id: 'codeBlock',
    label: tr('代码块'),
    description: tr('等宽代码'),
    group: 'basic',
    keywords: ['code', 'codeblock', 'pre', tr('代码')],
  },
  {
    id: 'table',
    label: tr('表格'),
    description: tr('插入 3 × 3 表格'),
    group: 'insert',
    keywords: ['table', 'grid', tr('表格'), tr('表')],
  },
  {
    id: 'blockMath',
    label: tr('公式块'),
    description: tr('独占一行的 LaTeX 公式'),
    group: 'insert',
    keywords: [
      'math',
      'equation',
      'latex',
      'katex',
      'formula',
      'block',
      tr('公式'),
      tr('数学'),
      tr('方程'),
    ],
  },
  {
    id: 'inlineMath',
    label: tr('行内公式'),
    description: tr('嵌在文字里的 LaTeX 公式'),
    group: 'insert',
    keywords: ['math', 'inline', 'latex', 'katex', 'formula', tr('公式'), tr('数学'), tr('行内')],
  },
  {
    id: 'divider',
    label: tr('分割线'),
    description: tr('水平分隔'),
    group: 'insert',
    keywords: [
      'hr',
      'divider',
      'rule',
      'line',
      'separator',
      tr('分割线'),
      tr('分隔线'),
      tr('横线'),
    ],
  },
  {
    id: 'image',
    label: tr('图片'),
    description: tr('上传图片，也可以直接粘贴或拖进来'),
    group: 'insert',
    keywords: ['image', 'img', 'picture', 'photo', tr('图片'), tr('照片'), tr('截图'), tr('插图')],
  },
  {
    id: 'attachment',
    label: tr('附件'),
    description: tr('上传文件（PDF、数据、代码…）'),
    group: 'insert',
    keywords: ['file', 'attachment', 'upload', 'pdf', tr('附件'), tr('文件'), tr('上传')],
  },
  {
    id: 'mention',
    label: tr('提及成员'),
    description: tr('@ 一位成员，对方会收到提醒'),
    group: 'insert',
    keywords: ['mention', 'at', '@', tr('提及'), tr('提到'), tr('成员'), tr('通知')],
  },
  {
    id: 'embedSheet',
    label: tr('嵌入表格'),
    description: tr('实时显示项目里的一个表格'),
    group: 'embed',
    keywords: ['embed', 'sheet', 'excel', 'table', tr('嵌入'), tr('表格'), tr('数据')],
  },
  {
    id: 'embedSlides',
    label: tr('嵌入幻灯片'),
    description: tr('在文档里翻看一份幻灯片'),
    group: 'embed',
    keywords: ['embed', 'slides', 'ppt', 'deck', tr('嵌入'), tr('幻灯片'), tr('演示')],
  },
  {
    id: 'embedDoc',
    label: tr('嵌入文档'),
    description: tr('引用项目里的另一篇文档（卡片）'),
    group: 'embed',
    keywords: ['embed', 'doc', 'page', 'link', tr('嵌入'), tr('文档'), tr('引用'), tr('论文')],
  },
  {
    id: 'newSheet',
    label: tr('新建一个表格并嵌入'),
    description: tr('建一个空表格，直接在这里填'),
    group: 'embed',
    keywords: ['new', 'sheet', 'create', 'embed', tr('新建'), tr('表格'), tr('嵌入')],
  },
  {
    id: 'aiContinue',
    label: tr('AI 续写'),
    description: tr('接着上文往下写'),
    group: 'ai',
    keywords: ['ai', 'continue', 'write', tr('续写'), tr('继续'), tr('写作'), tr('助手')],
  },
  {
    id: 'aiOutline',
    label: tr('AI 生成大纲'),
    description: tr('按文档主题列一份大纲'),
    group: 'ai',
    keywords: ['ai', 'outline', tr('大纲'), tr('提纲'), tr('目录'), tr('助手')],
  },
  {
    id: 'aiSummarize',
    label: tr('AI 总结全文'),
    description: tr('把整篇文档总结成一段'),
    group: 'ai',
    keywords: [
      'ai',
      'summary',
      'summarize',
      'tldr',
      tr('总结'),
      tr('摘要'),
      tr('概括'),
      tr('助手'),
    ],
  },
];

/**
 * 按输入过滤：标题前缀 > 标题包含 > 关键词前缀 > 关键词包含；同分保持原顺序。
 * 空格分开的多个词都要命中（"ai 大纲"）。
 */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  const scored: { item: SlashItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    const compactLabel = label.replace(/\s+/g, '');
    let total = 0;
    for (const term of terms) {
      let best = Infinity;
      if (label.startsWith(term) || compactLabel.startsWith(term)) best = 0;
      else if (label.includes(term) || compactLabel.includes(term)) best = 1;
      else if (item.keywords.some((k) => k.startsWith(term))) best = 2;
      else if (item.keywords.some((k) => k.includes(term))) best = 3;
      if (best === Infinity) return;
      total += best;
    }
    scored.push({ item, score: total, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.item);
}
