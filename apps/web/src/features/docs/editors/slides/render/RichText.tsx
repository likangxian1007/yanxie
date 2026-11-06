import type { CSSProperties, ReactNode } from 'react';
import type { PmMark, PmNode } from '../model/richtext';
import { cssFont } from '../model/themes';

/**
 * 文本框富文本的静态渲染（缩略图、放映、打印、AI 预览）。标签结构与 Tiptap 编辑时的 DOM 一致
 * （p / ul > li > p / strong / em / u / s / span[style]），样式都来自 slides.css 的 `.sl-text`，
 * 所以编辑态和展示态排版相同。
 */

export function markStyle(attrs: Record<string, unknown> | undefined): CSSProperties {
  const s: CSSProperties = {};
  if (!attrs) return s;
  if (typeof attrs.color === 'string' && attrs.color) s.color = attrs.color;
  if (typeof attrs.backgroundColor === 'string' && attrs.backgroundColor)
    s.backgroundColor = attrs.backgroundColor;
  if (typeof attrs.fontSize === 'string' && attrs.fontSize) s.fontSize = attrs.fontSize;
  if (typeof attrs.fontFamily === 'string' && attrs.fontFamily)
    s.fontFamily = cssFont(attrs.fontFamily);
  return s;
}

function wrapMark(mark: PmMark, child: ReactNode, key: number): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong key={key}>{child}</strong>;
    case 'italic':
      return <em key={key}>{child}</em>;
    case 'underline':
      return <u key={key}>{child}</u>;
    case 'strike':
      return <s key={key}>{child}</s>;
    case 'code':
      return <code key={key}>{child}</code>;
    case 'link':
      return (
        <a
          key={key}
          href={typeof mark.attrs?.href === 'string' ? mark.attrs.href : undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          {child}
        </a>
      );
    case 'textStyle':
      return (
        <span key={key} style={markStyle(mark.attrs)}>
          {child}
        </span>
      );
    default:
      return child;
  }
}

/** 标记嵌套顺序与 ProseMirror 一致：textStyle 最外层（优先级高的在外） */
const MARK_ORDER = ['link', 'textStyle', 'bold', 'italic', 'underline', 'strike', 'code'];

function renderInline(n: PmNode, key: number): ReactNode {
  if (n.type === 'hardBreak') return <br key={key} />;
  if (n.type !== 'text') return null;
  const marks = [...(n.marks ?? [])].sort(
    (a, b) => MARK_ORDER.indexOf(b.type) - MARK_ORDER.indexOf(a.type),
  );
  let node: ReactNode = n.text ?? '';
  marks.forEach((m, i) => {
    node = wrapMark(m, node, i);
  });
  return (
    <span key={key} className="sl-run">
      {node}
    </span>
  );
}

export function paragraphStyle(attrs: Record<string, unknown> | undefined): CSSProperties {
  const s: CSSProperties = {};
  const align = attrs?.textAlign;
  if (align === 'left' || align === 'center' || align === 'right' || align === 'justify')
    s.textAlign = align;
  const lh = attrs?.lineHeight;
  if (typeof lh === 'number' || (typeof lh === 'string' && lh)) s.lineHeight = String(lh);
  return s;
}

function renderBlock(n: PmNode, key: number): ReactNode {
  const children = (n.content ?? []).map((c, i) => renderNode(c, i));
  switch (n.type) {
    case 'paragraph':
      return (
        <p key={key} style={paragraphStyle(n.attrs)}>
          {children.length ? children : <br />}
        </p>
      );
    case 'bulletList':
      return <ul key={key}>{children}</ul>;
    case 'orderedList': {
      const start = Number(n.attrs?.start ?? 1);
      return (
        <ol key={key} start={Number.isFinite(start) && start !== 1 ? start : undefined}>
          {children}
        </ol>
      );
    }
    case 'listItem':
      return <li key={key}>{children}</li>;
    default:
      return <div key={key}>{children}</div>;
  }
}

function renderNode(n: PmNode, key: number): ReactNode {
  if (n.type === 'text' || n.type === 'hardBreak') return renderInline(n, key);
  return renderBlock(n, key);
}

export function RichTextStatic({ doc }: { doc: PmNode }) {
  const content = doc.content?.length ? doc.content : [{ type: 'paragraph' }];
  return <>{content.map((n, i) => renderNode(n, i))}</>;
}
