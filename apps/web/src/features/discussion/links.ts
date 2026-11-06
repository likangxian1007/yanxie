export function parseDiscussion(value: string | null): string | null {
  return value && /^(project|thr_[A-Za-z0-9]+)$/.test(value) ? value : null;
}

export function discussionParams(search: string, scope: string) {
  const params = new URLSearchParams(search);
  params.delete('thread');
  params.delete('threadTab');
  params.delete('preview');
  params.set('discussion', scope);
  return params;
}
