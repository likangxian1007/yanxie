import { Link, Navigate } from 'react-router';
import { ProjectCreateForm } from '@/components/layout/ProjectCreateForm';
import { isUnauthorized, useMe } from '@/lib/session';
import { AuthLayout } from './AuthLayout';
import { FullPageLoading } from './FullPageState';
import { tr } from '@/lib/i18n';

/** /new：还没有任何课题时的引导页。 */
export function NewProjectPage() {
  const me = useMe();
  if (me.isPending) return <FullPageLoading />;
  if (me.error && isUnauthorized(me.error)) return <Navigate to="/login?next=/new" replace />;
  return (
    <AuthLayout
      title={tr('新建一个课题')}
      description={tr(
        '课题是团队协作的单位：共用一个协调者、一套文档、看板和研究空间。建好后可以邀请组员和导师。',
      )}
      footer={
        <>
          <Link to="/library" className="text-accent-text hover:underline">
            {tr('先使用个人文献库')}
          </Link>
          <p className="mt-2">{tr('也可以让组里的负责人发你一个邀请链接。')}</p>
        </>
      }
    >
      <ProjectCreateForm />
    </AuthLayout>
  );
}
