import { tr } from '@/lib/i18n';
export const RESOURCE_LABEL: Record<ResourceType, string> = {
  doc: tr('文档'),
  paper: tr('论文'),
  experiment: tr('实验'),
  review: tr('审阅'),
  report: tr('组会汇报'),
};

export const RESOURCE_TYPES = ['doc', 'paper', 'experiment', 'review', 'report'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export interface ResourcePreview {
  type: ResourceType;
  id: string;
}
export interface PreviewLocation {
  pathname: string;
  search: string;
}

export function parsePreview(value: string | null): ResourcePreview | null {
  if (!value) return null;
  const match = /^(doc|paper|experiment|review|report):([^\s:/?#]+)$/.exec(value);
  return match ? { type: match[1] as ResourceType, id: match[2]! } : null;
}

export function previewHref(location: PreviewLocation, type: ResourceType, id: string): string {
  const params = new URLSearchParams(location.search);
  params.delete('discussion');
  params.delete('thread');
  params.delete('threadTab');
  params.set('preview', `${type}:${id}`);
  return `${location.pathname}?${params}`;
}

export function previewReturnTo(location: PreviewLocation): string {
  const params = new URLSearchParams(location.search);
  params.delete('preview');
  params.delete('discussion');
  params.delete('thread');
  params.delete('threadTab');
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ''}`;
}

export function resourcePageHref(
  projectId: string,
  resource: ResourcePreview,
  returnTo: string,
): string {
  const segment: Record<ResourceType, string> = {
    doc: 'docs',
    paper: 'library',
    experiment: 'experiments',
    review: 'reviews',
    report: 'reports',
  };
  return `/p/${encodeURIComponent(projectId)}/${segment[resource.type]}/${encodeURIComponent(resource.id)}?${new URLSearchParams({ returnTo })}`;
}

let trigger: HTMLElement | null = null;
export function rememberPreviewTrigger(element: HTMLElement): void {
  trigger = element;
}
export function previewFocusTarget(): HTMLElement | null {
  return trigger?.isConnected ? trigger : null;
}
