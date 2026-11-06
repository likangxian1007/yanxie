import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ImageView } from './ImageView';
import { AttachmentView } from './AttachmentView';
import { DocEmbedView } from './DocEmbedView';

/**
 * 富文本里我们自己加的节点：图片、附件、内嵌文档、@提及。
 * 名字、分组、属性必须与服务端 `apps/server/src/modules/documents/pm-nodes.ts` 一致
 * （服务端按同一套 schema 做 markdown ⇄ Y.XmlFragment 转换），这里只多了交互（NodeView）。
 */
export const RICH_CUSTOM_NODES = {
  image: ['src', 'alt', 'caption', 'fileId', 'width', 'align'],
  fileAttachment: ['href', 'fileId', 'name', 'size', 'mime'],
  docEmbed: ['docId', 'kind', 'title', 'height'],
  mention: ['id', 'label'],
} as const;

/** NodeView 里的输入框、内嵌编辑器自己处理事件，不交给 ProseMirror */
function ownsEvent(event: Event): boolean {
  const t = event.target;
  return t instanceof Element && !!t.closest('[data-node-interactive]');
}

export const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
      caption: { default: '' },
      fileId: { default: null },
      width: { default: null },
      align: { default: 'center' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'figure[data-type="image"]',
        getAttrs: (el) => {
          const img = (el as HTMLElement).querySelector('img');
          return img
            ? { src: img.getAttribute('src') ?? '', alt: img.getAttribute('alt') ?? '' }
            : false;
        },
      },
      {
        tag: 'img[src]',
        getAttrs: (el) => ({
          src: (el as HTMLElement).getAttribute('src') ?? '',
          alt: (el as HTMLElement).getAttribute('alt') ?? '',
        }),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'figure',
      { 'data-type': 'image' },
      ['img', { src: HTMLAttributes.src, alt: HTMLAttributes.alt }],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView, { stopEvent: ({ event }) => ownsEvent(event) });
  },
});

export const FileAttachmentNode = Node.create({
  name: 'fileAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      href: { default: '' },
      fileId: { default: null },
      name: { default: '' },
      size: { default: null },
      mime: { default: '' },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="file-attachment"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'file-attachment' }, HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView, { stopEvent: ({ event }) => ownsEvent(event) });
  },
});

export const DocEmbedNode = Node.create({
  name: 'docEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      docId: { default: '' },
      kind: { default: 'sheet' },
      title: { default: '' },
      height: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="doc-embed"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'doc-embed' }, HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DocEmbedView, {
      stopEvent: ({ event }) => ownsEvent(event),
      ignoreMutation: () => true,
    });
  },
});

export const MentionNode = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      id: { default: '' },
      label: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-type="mention"]',
        getAttrs: (el) => ({
          id: (el as HTMLElement).getAttribute('data-id') ?? '',
          label:
            (el as HTMLElement).getAttribute('data-label') ??
            ((el as HTMLElement).textContent ?? '').replace(/^@/u, ''),
        }),
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'span',
      {
        'data-type': 'mention',
        'data-id': String(node.attrs.id ?? ''),
        'data-label': String(node.attrs.label ?? ''),
        class: 'rich-mention',
      },
      `@${String(node.attrs.label ?? '')}`,
    ];
  },
  renderText({ node }) {
    return `@${String(node.attrs.label ?? '')}`;
  },
});

export const RICH_CUSTOM_EXTENSIONS = [ImageNode, FileAttachmentNode, DocEmbedNode, MentionNode];
