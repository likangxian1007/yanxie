import { Extension, type Editor, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { toast } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { fileUrl, isImageFile, uploadFile, uploadProblem } from './upload';
import { tr } from '@/lib/i18n';

/**
 * 图片 / 附件上传：粘贴、拖进来、工具栏或斜杠菜单选文件，都走 uploadFiles。
 * 上传期间只在本地显示一个占位（widget 装饰，带进度），不写进协同文档；
 * 传完后在占位处插入图片 / 附件节点（只带文件 id 和地址，别人看到的就是成品）。
 * 占位位置用 editor.utils 的可映射位置跟随（本地编辑按 mapping，远端修改按 Y 相对位置）。
 */
interface Pending {
  id: string;
  pos: ReturnType<Editor['utils']['createMappablePosition']>;
  name: string;
  image: boolean;
}

type UploadMeta = { add: Pending } | { remove: string };

export const uploadKey = new PluginKey<Pending[]>('richUploads');

/** 占位 DOM：插件和上传进度共用（进度直接改 DOM，不走事务） */
const placeholders = new Map<string, HTMLElement>();

function placeholderEl(p: Pending): HTMLElement {
  let el = placeholders.get(p.id);
  if (el) return el;
  el = document.createElement('span');
  el.className = `rich-upload ${p.image ? 'rich-upload-image' : 'rich-upload-file'}`;
  el.contentEditable = 'false';
  el.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.className = 'rich-upload-label';
  label.textContent = tr('正在上传 {name}', { name: p.name });
  const bar = document.createElement('span');
  bar.className = 'rich-upload-bar';
  const fill = document.createElement('span');
  fill.className = 'rich-upload-fill';
  bar.appendChild(fill);
  el.append(label, bar);
  placeholders.set(p.id, el);
  return el;
}

function setProgress(id: string, fraction: number) {
  const fill = placeholders.get(id)?.querySelector<HTMLElement>('.rich-upload-fill');
  if (fill) fill.style.transform = `scaleX(${Math.max(0.04, Math.min(1, fraction))})`;
}

export const MediaUpload = Extension.create<{ projectId: string }>({
  name: 'richMediaUpload',
  addOptions() {
    return { projectId: '' };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const projectId = () => this.options.projectId;
    return [
      new Plugin<Pending[]>({
        key: uploadKey,
        state: {
          init: () => [],
          apply(tr, prev) {
            let next = prev;
            if (tr.docChanged && prev.length) {
              next = prev.map((p) => ({
                ...p,
                pos: editor.utils.getUpdatedPosition(p.pos, tr).position,
              }));
            }
            const meta = tr.getMeta(uploadKey) as UploadMeta | undefined;
            if (!meta) return next;
            if ('add' in meta) return [...next, meta.add];
            return next.filter((p) => p.id !== meta.remove);
          },
        },
        props: {
          decorations(state) {
            const list = uploadKey.getState(state) ?? [];
            if (!list.length) return null;
            const size = state.doc.content.size;
            return DecorationSet.create(
              state.doc,
              list.map((p) =>
                Decoration.widget(Math.min(p.pos.position, size), () => placeholderEl(p), {
                  key: p.id,
                  side: -1,
                }),
              ),
            );
          },
          handlePaste(_view, event) {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (!files.length || !editor.isEditable) return false;
            event.preventDefault();
            uploadFiles(editor, projectId(), files);
            return true;
          },
          handleDrop(view, event) {
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (!files.length || !editor.isEditable) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            uploadFiles(editor, projectId(), files, at?.pos);
            return true;
          },
        },
      }),
    ];
  },
});

function pendingPosition(editor: Editor, id: string): number | null {
  const p = (uploadKey.getState(editor.state) ?? []).find((x) => x.id === id);
  return p ? Math.min(p.pos.position, editor.state.doc.content.size) : null;
}

/** 在 pos 处插入一个块：pos 在空段落里就替换掉这个段落 */
export function insertBlockAt(editor: Editor, pos: number, content: JSONContent) {
  const $pos = editor.state.doc.resolve(pos);
  const parent = $pos.parent;
  if (parent.type.name === 'paragraph' && parent.content.size === 0 && $pos.depth > 0) {
    editor.chain().insertContentAt({ from: $pos.before(), to: $pos.after() }, content).run();
    return;
  }
  editor.chain().insertContentAt(pos, content).run();
}

export function fileToNode(
  projectId: string,
  file: { id: string; name: string; size: number; mime: string },
  image: boolean,
): JSONContent {
  if (image) {
    return {
      type: 'image',
      attrs: {
        src: fileUrl(projectId, file.id),
        alt: file.name.replace(/\.[^.]+$/u, ''),
        fileId: file.id,
      },
    };
  }
  return {
    type: 'fileAttachment',
    attrs: {
      href: fileUrl(projectId, file.id),
      fileId: file.id,
      name: file.name,
      size: file.size,
      mime: file.mime,
    },
  };
}

/**
 * 上传一组文件并在 pos（默认光标处）依次插入。`asAttachment` 时图片也当附件插入。
 */
export function uploadFiles(
  editor: Editor,
  projectId: string,
  files: File[],
  pos?: number,
  asAttachment = false,
) {
  let at = pos ?? editor.state.selection.from;
  for (const file of files) {
    const problem = uploadProblem(file);
    if (problem) {
      toast({
        title: tr('{name} 没有上传', { name: file.name }),
        description: problem,
        tone: 'warning',
      });
      continue;
    }
    const image = !asAttachment && isImageFile(file);
    const id = `up_${Math.random().toString(36).slice(2, 10)}`;
    const pending: Pending = {
      id,
      pos: editor.utils.createMappablePosition(at),
      name: file.name,
      image,
    };
    editor.view.dispatch(editor.state.tr.setMeta(uploadKey, { add: pending } satisfies UploadMeta));
    const handle = uploadFile(projectId, file, (f) => setProgress(id, f));
    const finish = () => {
      placeholders.delete(id);
      if (!editor.isDestroyed) {
        editor.view.dispatch(
          editor.state.tr.setMeta(uploadKey, { remove: id } satisfies UploadMeta),
        );
      }
    };
    handle.promise
      .then((obj) => {
        if (editor.isDestroyed) return;
        const where = pendingPosition(editor, id);
        finish();
        if (where === null) return;
        insertBlockAt(editor, where, fileToNode(projectId, obj, image));
      })
      .catch((err: unknown) => {
        finish();
        if (err instanceof DOMException && err.name === 'AbortError') return;
        toast({
          title: tr('{name} 上传失败', { name: file.name }),
          description: err instanceof ApiRequestError ? err.message : tr('请稍后再试'),
          tone: 'danger',
        });
      });
    at = Math.min(at, editor.state.doc.content.size);
  }
}

/** 打开系统文件选择框 */
export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}
