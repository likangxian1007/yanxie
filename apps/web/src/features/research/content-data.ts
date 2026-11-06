import type { Page, ResearchArtifactVersion, ResearchStructuredTable } from '@srh/shared';
import { api, resolveApiUrl } from '@/lib/api';
import { recordRoot, root } from './data';

export const contentApi = {
  table: (
    pid: string,
    recordId: string,
    itemId: string,
    options: { sheetId?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ) =>
    api.get<ResearchStructuredTable>(`${recordRoot(pid, recordId)}/items/${itemId}/table`, {
      signal: options.signal,
      query: { sheetId: options.sheetId, cursor: options.cursor, limit: options.limit },
    }),
  tableExportUrl: (pid: string, recordId: string, itemId: string, sheetId?: string) =>
    resolveApiUrl(`${recordRoot(pid, recordId)}/items/${itemId}/table/export`, { sheetId }),
  artifacts: (
    pid: string,
    recordId: string,
    itemId: string,
    cursor?: string,
    signal?: AbortSignal,
  ) =>
    api.get<Page<ResearchArtifactVersion>>(
      `${recordRoot(pid, recordId)}/items/${itemId}/artifacts`,
      {
        signal,
        query: { cursor, limit: 50 },
      },
    ),
  artifact: (pid: string, artifactId: string, signal?: AbortSignal) =>
    api.get<ResearchArtifactVersion>(`${root(pid)}/artifacts/${artifactId}`, { signal }),
  artifactTable: (pid: string, artifactId: string, signal?: AbortSignal) =>
    api.get<ResearchStructuredTable>(`${root(pid)}/artifacts/${artifactId}/download`, { signal }),
  artifactUrl: (pid: string, artifactId: string) =>
    resolveApiUrl(`${root(pid)}/artifacts/${artifactId}/download`),
  artifactPreviewUrl: (pid: string, artifactId: string) =>
    resolveApiUrl(`${root(pid)}/artifacts/${artifactId}/download`, { inline: 1 }),
  fileUrl: (pid: string, id: string, download = false) =>
    resolveApiUrl(`/projects/${pid}/files/${id}`, download ? { download: 1 } : undefined),
};
