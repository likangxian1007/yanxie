import { clientId } from '@/lib/client-id';
import { useCallback } from 'react';
import { create } from 'zustand';
import { ApiErrorBody, FileObject } from '@srh/shared';
import { resolveApiUrl } from '@/lib/api';
import { tr } from '@/lib/i18n';

export type ConversationChannel = 'agent' | 'team';
export type AttachmentStatus = 'uploading' | 'ready' | 'error';
export interface ConversationAttachment {
  id: string;
  name: string;
  size: number;
  status: AttachmentStatus;
  file?: File;
  fileId?: string;
  error?: string;
}

interface AttachmentDraft {
  files: ConversationAttachment[];
  notice: string | null;
}

const EMPTY: AttachmentDraft = { files: [], notice: null };
const LIMIT = 20;
const MAX_BYTES = 20 * 1024 * 1024;
const uploads = new Map<string, AbortController>();
const useAttachmentStore = create<{ drafts: Record<string, AttachmentDraft> }>(() => ({
  drafts: {},
}));

/** 不同附件使用不同路径，避免服务端为同时上传的同名文件分配相同路径。 */
function attachmentPath(id: string, originalName: string) {
  const base = originalName.replace(/\\/gu, '/').split('/').pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[<>:"|?*]/gu, '_')
    .trim()
    .replace(/[. ]+$/u, '');
  const safeName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu.test(cleaned)
    ? `_${cleaned}`
    : cleaned || 'file';
  // 同时满足服务端 300 字符路径上限和常见文件系统单段 255 字节上限。
  const dot = safeName.lastIndexOf('.');
  const extension = dot > 0 && safeName.length - dot <= 20 ? safeName.slice(dot) : '';
  const stem = extension ? safeName.slice(0, dot) : safeName;
  const encoder = new TextEncoder();
  let shortStem = '';
  for (const character of stem) {
    if (encoder.encode(shortStem + character + extension).length > 200) break;
    shortStem += character;
  }
  const name = `${shortStem.replace(/[. ]+$/u, '') || 'file'}${extension}`;
  return `uploads/conversations/${id}/${name}`;
}

function draftKey(
  userId: string,
  projectId: string,
  threadId: string | null,
  channel: ConversationChannel,
) {
  return JSON.stringify([userId, projectId, threadId, channel]);
}

function updateDraft(key: string, change: (draft: AttachmentDraft) => AttachmentDraft) {
  useAttachmentStore.setState((state) => ({
    drafts: { ...state.drafts, [key]: change(state.drafts[key] ?? EMPTY) },
  }));
}

function updateFile(
  key: string,
  id: string,
  change: (file: ConversationAttachment) => ConversationAttachment,
) {
  updateDraft(key, (draft) => ({
    ...draft,
    files: draft.files.map((file) => (file.id === id ? change(file) : file)),
  }));
}

async function uploadFile(key: string, projectId: string, id: string, file: File) {
  const previous = uploads.get(id);
  previous?.abort();
  const controller = new AbortController();
  uploads.set(id, controller);
  updateFile(key, id, (item) => ({ ...item, status: 'uploading', error: undefined }));
  const form = new FormData();
  form.append('file', file);
  form.append('path', attachmentPath(id, file.name));
  try {
    const response = await fetch(resolveApiUrl(`/projects/${projectId}/files`), {
      method: 'POST',
      body: form,
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      let message =
        response.status === 413 ? tr('文件不能超过 20 MB') : tr('文件上传失败，请重试。');
      try {
        const parsed = ApiErrorBody.safeParse(await response.json());
        if (parsed.success) message = parsed.data.error.message;
      } catch {
        /* 使用通用错误提示 */
      }
      throw new Error(message);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(tr('服务器返回的文件信息无法识别，请重试。'));
    }
    const result = FileObject.safeParse(payload);
    if (!result.success || result.data.projectId !== projectId) {
      throw new Error(tr('服务器返回的文件信息无法识别，请重试。'));
    }
    if (uploads.get(id) !== controller) return;
    uploads.delete(id);
    updateFile(key, id, (item) => ({
      ...item,
      status: 'ready',
      fileId: result.data.id,
      file: undefined,
      error: undefined,
    }));
  } catch (error) {
    if (uploads.get(id) !== controller) return;
    uploads.delete(id);
    if (controller.signal.aborted) return;
    updateFile(key, id, (item) => ({
      ...item,
      status: 'error',
      error:
        error instanceof TypeError
          ? tr('无法连接服务器，请检查网络后重试。')
          : error instanceof Error
            ? error.message
            : tr('文件上传失败，请重试。'),
    }));
  }
}

/** 只清除已成功发送的那批文件，其他新增或失败的文件仍留在对应草稿里。 */
export function clearSubmittedAttachments(
  userId: string | undefined,
  projectId: string,
  threadId: string | null,
  channel: ConversationChannel,
  fileIds: readonly string[],
) {
  if (!userId || !fileIds.length) return;
  const key = draftKey(userId, projectId, threadId, channel);
  const submitted = new Set(fileIds);
  updateDraft(key, (draft) => ({
    ...draft,
    files: draft.files.filter(
      (file) => file.status !== 'ready' || !file.fileId || !submitted.has(file.fileId),
    ),
    notice: null,
  }));
}

/** 会话内暂存上传状态；按用户、项目、线程与消息频道隔离。 */
export function useConversationAttachments(
  userId: string | undefined,
  projectId: string,
  threadId: string | null,
  channel: ConversationChannel,
) {
  const key = userId ? draftKey(userId, projectId, threadId, channel) : null;
  const draft = useAttachmentStore((state) => (key ? (state.drafts[key] ?? EMPTY) : EMPTY));
  const add = useCallback(
    (selected: FileList | readonly File[]) => {
      if (!key) return;
      const files = Array.from(selected);
      const existing = useAttachmentStore.getState().drafts[key]?.files ?? [];
      const accepted = files.slice(0, Math.max(0, LIMIT - existing.length));
      const entries: ConversationAttachment[] = accepted.map((file) => ({
        id: clientId(),
        name: file.name,
        size: file.size,
        file,
        status: file.size > MAX_BYTES ? 'error' : 'uploading',
        ...(file.size > MAX_BYTES ? { error: tr('文件不能超过 20 MB，请移除后重新选择。') } : {}),
      }));
      updateDraft(key, (draft) => ({
        files: [...draft.files, ...entries],
        notice: accepted.length < files.length ? tr('每条消息最多添加 20 个附件。') : null,
      }));
      for (const item of entries) {
        if (item.status === 'uploading' && item.file)
          void uploadFile(key, projectId, item.id, item.file);
      }
    },
    [key, projectId],
  );
  const remove = useCallback(
    (id: string) => {
      if (!key) return;
      const controller = uploads.get(id);
      uploads.delete(id);
      controller?.abort();
      updateDraft(key, (draft) => ({
        files: draft.files.filter((item) => item.id !== id),
        notice: null,
      }));
    },
    [key],
  );
  const retry = useCallback(
    (id: string) => {
      if (!key) return;
      const item = useAttachmentStore.getState().drafts[key]?.files.find((file) => file.id === id);
      if (!item?.file || item.status !== 'error' || item.file.size > MAX_BYTES) return;
      void uploadFile(key, projectId, item.id, item.file);
    },
    [key, projectId],
  );
  const clearSubmitted = useCallback(
    (ids: readonly string[]) => {
      clearSubmittedAttachments(userId, projectId, threadId, channel, ids);
    },
    [userId, projectId, threadId, channel],
  );
  return {
    projectId,
    files: draft.files,
    notice: draft.notice,
    fileIds: draft.files.flatMap((file) =>
      file.status === 'ready' && file.fileId ? [file.fileId] : [],
    ),
    isUploading: draft.files.some((file) => file.status === 'uploading'),
    hasErrors: draft.files.some((file) => file.status === 'error'),
    add,
    remove,
    retry,
    clearSubmitted,
  };
}

export type ConversationAttachments = ReturnType<typeof useConversationAttachments>;
