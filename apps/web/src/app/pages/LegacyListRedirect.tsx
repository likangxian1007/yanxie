import { Navigate, useLocation } from 'react-router';
export function LegacyListRedirect({ path, view }: { path: string; view: string }) {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  query.set('view', view);
  return (
    <Navigate
      replace
      to={{
        pathname: location.pathname.replace(/\/[^/]+\/?$/, `/${path}`),
        search: `?${query}`,
        hash: location.hash,
      }}
    />
  );
}
