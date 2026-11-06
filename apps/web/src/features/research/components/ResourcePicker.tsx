import { useQuery } from '@tanstack/react-query';
import type { ResearchResourceKind, ResearchResourceRef } from '@srh/shared';
import { Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { researchApi } from '../data';
import { WorkspaceMaterialUpload } from './WorkspaceMaterialUpload';
import { tr } from '@/lib/i18n';

interface NamedResource {
  id: string;
  title?: string;
  name?: string;
  path?: string;
}
const LABEL: Record<ResearchResourceKind, string> = {
  file: tr('项目文件'),
  document: tr('团队文档'),
  paper: tr('团队论文'),
  notebook: 'Notebook',
  experiment: tr('旧实验'),
  research: tr('研究空间'),
  link: tr('链接'),
};
const KINDS = (Object.keys(LABEL) as ResearchResourceKind[]).filter(
  (kind) => kind !== 'experiment',
);

async function options(
  pid: string,
  kind: ResearchResourceKind,
  signal: AbortSignal,
): Promise<NamedResource[]> {
  const root = `/projects/${pid}`;
  switch (kind) {
    case 'file':
      return api.get<NamedResource[]>(`${root}/files`, { signal });
    case 'document':
      return api.get<NamedResource[]>(`${root}/docs?space=team`, { signal });
    case 'paper':
      return api.get<NamedResource[]>(`${root}/library/papers?space=team`, { signal });
    case 'notebook':
      return api.get<NamedResource[]>(`${root}/notebooks`, { signal });
    case 'experiment':
      return [];
    case 'research':
      return researchApi.records(pid, signal);
    case 'link':
      return [];
  }
}

/** 资源按类型从已有项目对象里选，不预加载对应编辑器。 */
export function ResourcePicker({
  pid,
  value,
  onChange,
  label = tr('关联资源'),
  fixedKind,
  disabled = false,
  active = true,
  allowUpload = false,
  onUploadTitle,
}: {
  pid: string;
  value: ResearchResourceRef | null;
  onChange: (value: ResearchResourceRef | null) => void;
  label?: string;
  fixedKind?: ResearchResourceKind;
  disabled?: boolean;
  active?: boolean;
  allowUpload?: boolean;
  onUploadTitle?: (title: string) => void;
}) {
  const kind = fixedKind ?? value?.kind ?? 'document';
  const query = useQuery({
    queryKey: ['p', pid, 'resource-picker', 'team', kind],
    queryFn: ({ signal }) => options(pid, kind, signal),
    enabled: !!pid && kind !== 'link' && active,
  });
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <Select
        aria-label={tr('{label}类型', { label })}
        value={kind}
        disabled={!!fixedKind || disabled}
        onChange={(e) => onChange({ kind: e.target.value as ResearchResourceKind, id: '' })}
      >
        {KINDS.map((item) => (
          <option key={item} value={item}>
            {LABEL[item]}
          </option>
        ))}
      </Select>
      {kind === 'link' ? (
        <Input
          aria-label={tr('{label}网址', { label })}
          type="url"
          placeholder="https://…"
          value={value?.id ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ kind, id: e.target.value })}
        />
      ) : (
        <Select
          aria-label={label}
          value={value?.id ?? ''}
          onChange={(e) => onChange(e.target.value ? { kind, id: e.target.value } : null)}
          disabled={query.isPending || disabled}
        >
          <option value="">
            {query.isPending
              ? tr('正在加载…')
              : query.isError
                ? tr('资源加载失败')
                : tr('选择资源')}
          </option>
          {(query.data ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {item.title || item.name || item.path || item.id}
            </option>
          ))}
        </Select>
      )}
      {(kind === 'document' || kind === 'paper') && (
        <span className="text-caption text-fg-muted sm:col-span-2">
          {tr('个人资料请先加入团队空间，再关联到研究空间。')}
        </span>
      )}
      {query.isError && (
        <span className="text-caption text-danger sm:col-span-2">
          {tr('资源没有加载出来，请稍后重试。')}
        </span>
      )}
      {allowUpload && (!fixedKind || fixedKind === 'file') && (
        <WorkspaceMaterialUpload
          pid={pid}
          disabled={disabled}
          onUploaded={(file) => {
            onChange({ kind: 'file', id: file.id });
            onUploadTitle?.(file.name);
          }}
        />
      )}
    </div>
  );
}
