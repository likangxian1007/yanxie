import { useLocation } from 'react-router';

/** Only restore the originating list, never another project or an external destination. */
export function listReturnHref(fallback: string, search: string, state?: unknown): string {
  const candidate =
    new URLSearchParams(search).get('returnTo') ??
    (state && typeof state === 'object' && 'returnTo' in state ? state.returnTo : null);
  if (typeof candidate !== 'string' || !candidate.startsWith('/') || candidate.startsWith('//'))
    return fallback;
  try {
    const url = new URL(candidate, 'https://local.invalid');
    if (url.origin !== 'https://local.invalid' || url.pathname !== fallback.split('?')[0])
      return fallback;
    url.searchParams.delete('preview');
    url.searchParams.delete('thread');
    url.searchParams.delete('returnTo');
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}

export function useListReturnHref(fallback: string): string {
  const location = useLocation();
  return listReturnHref(fallback, location.search, location.state);
}
