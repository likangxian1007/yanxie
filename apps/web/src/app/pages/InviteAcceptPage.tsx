import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { MailX } from 'lucide-react';
import type { Project } from '@srh/shared';
import { Button, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { isUnauthorized, rememberProject, useMe } from '@/lib/session';
import { FullPageError, FullPageLoading } from './FullPageState';
import { tr } from '@/lib/i18n';

/** /invite/:token：已登录直接接受邀请进项目；未登录先去注册（带上 token）。 */
export function InviteAcceptPage() {
  const { token = '' } = useParams();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const loggedIn = Boolean(me.data);

  useEffect(() => {
    if (!loggedIn || started.current) return;
    started.current = true;
    api
      .post<Project>(`/invites/${encodeURIComponent(token)}/accept`)
      .then(async (project) => {
        rememberProject(project.id);
        await qc.invalidateQueries({ queryKey: qk.me });
        navigate(`/p/${project.id}`, { replace: true });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : tr('邀请链接无效。'));
      });
  }, [loggedIn, token, qc, navigate]);

  if (me.isPending) return <FullPageLoading />;
  if (me.error) {
    if (isUnauthorized(me.error))
      return <Navigate to={`/register?invite=${encodeURIComponent(token)}`} replace />;
    return <FullPageError error={me.error} onRetry={() => void me.refetch()} />;
  }
  if (error) {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas px-4">
        <EmptyState
          icon={MailX}
          title={tr('这个邀请用不了')}
          description={tr('{error} 可以请项目负责人重新发一个邀请链接。', { error })}
          action={
            <Button variant="primary" onClick={() => navigate('/')}>
              {tr('回到首页')}
            </Button>
          }
        >
          <Link to="/new" className="mt-3 text-small text-accent-text hover:underline">
            {tr('或者新建一个课题')}
          </Link>
        </EmptyState>
      </div>
    );
  }
  return <FullPageLoading />;
}
