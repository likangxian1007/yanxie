import { Navigate } from 'react-router';
import { useProjectId } from '@/lib/project';

/** 旧书签回到研究空间，不再加载已撤下的管理界面。 */
export function ResearchRetiredRedirectPage() {
  const pid = useProjectId();
  return <Navigate to={`/p/${pid}/research`} replace />;
}
