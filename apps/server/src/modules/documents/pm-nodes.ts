import { Node, mergeAttributes } from '@tiptap/core';

/**
 * 富文本里我们自己加的节点（图片、附件、内嵌文档、@提及）的 schema 部分。
 * 前端 `apps/web/src/features/docs/editors/rich/nodes/*` 在同名节点上加了交互（NodeView），
 * 但名字、分组、属性必须与这里一致（两边都有测试对照 RICH_CUSTOM_NODES）。
 */
export const RICH_CUSTOM_NODES = {
  image: ['src', 'alt', 'caption', 'fileId', 'width', 'align'],
  fileAttachment: ['href', 'fileId', 'name', 'size', 'mime'],
  docEmbed: ['docId', 'kind', 'title', 'height'],
  mention: ['id', 'label'],
} as const;

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
    return [{ tag: 'figure[data-type="image"]' }, { tag: 'img[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes({ 'data-type': 'image' }), ['img', HTMLAttributes]];
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
    return [{ tag: 'span[data-type="mention"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-type': 'mention' }, HTMLAttributes),
      `@${String(node.attrs.label ?? '')}`,
    ];
  },
  renderText({ node }) {
    return `@${String(node.attrs.label ?? '')}`;
  },
});

export const RICH_CUSTOM_EXTENSIONS = [ImageNode, FileAttachmentNode, DocEmbedNode, MentionNode];
