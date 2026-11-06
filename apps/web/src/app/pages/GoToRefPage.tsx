import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { MessageSquareOff } from 'lucide-react';
import type { Decision, Message, Thread } from '@srh/shared';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { resolveRefPath } from '@/lib/message-link';
import { tr } from '@/lib/i18n';

/**
 * /p/:projectId/go/:refId：站内引用 #msg_… / #dec_… 的跳转页。
 * 查出这条消息（或决策卡）在时间线还是哪个线程里，换成真正的地址（带 #msg_…，
 * MessageFeed 会滚过去并高亮），用 replace 跳走，浏览器后退不会再回到这里。
 */
export function GoToRefPage() {
  const { projectId = '', refId = '' } = useParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState<'missing' | 'error' | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const base = `/projects/${projectId}`;
    resolveRefPath(projectId, refId, {
      message: (id) => api.get<Message>(`${base}/messages/${id}`, { signal }),
      decision: (id) => api.get<Decision>(`${base}/decisions/${id}`, { signal }),
      thread: (id) => api.get<Thread>(`${base}/threads/${id}`, { signal }),
    })
      .then((path) => {
        if (!signal.aborted) navigate(path, { replace: true });
      })
      .catch((err: unknown) => {
        if (signal.aborted) return;
        const missing =
          !(err instanceof ApiRequestError) || err.status === 404 || err.status === 403;
        setFailed(missing ? 'missing' : 'error');
      });
    return () => controller.abort();
  }, [projectId, refId, navigate]);

  if (!failed) {
    return (
      <div className="flex flex-1 items-center justify-center py-16 text-fg-subtle">
        <Spinner size={18} label={tr('正在找到这条消息')} />
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <EmptyState
        icon={MessageSquareOff}
        title={failed === 'missing' ? tr('找不到这条消息') : tr('暂时打不开这条消息')}
        description={
          failed === 'missing'
            ? tr('它可能已经被删除，或者在别人的个人会话里。')
            : tr('请检查网络后再试一次。')
        }
        action={
          <>
            <Button variant="secondary" onClick={() => navigate(-1)}>
              {tr('返回上一页')}
            </Button>
            <Button variant="primary" onClick={() => navigate(`/p/${projectId}`)}>
              {tr('回到协作台')}
            </Button>
          </>
        }
      />
    </div>
  );
}
