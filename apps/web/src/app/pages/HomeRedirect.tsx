import { Navigate } from 'react-router';
import { isUnauthorized, lastProject, useMe } from '@/lib/session';
import { FullPageError, FullPageLoading } from './FullPageState';

/** `/`：未登录去登录页；否则回到上次打开的项目，没有项目就使用个人文献库。 */
export function HomeRedirect() {
  const me = useMe();
  if (me.isPending) return <FullPageLoading />;
  if (me.error) {
    if (isUnauthorized(me.error)) return <Navigate to="/login" replace />;
    return <FullPageError error={me.error} onRetry={() => void me.refetch()} />;
  }
  const projects = me.data.projects.filter((p) => !p.archivedAt);
  if (projects.length === 0) return <Navigate to="/library" replace />;
  const last = lastProject();
  const target = projects.find((p) => p.id === last) ?? projects[0];
  return <Navigate to={`/p/${target?.id}`} replace />;
}
