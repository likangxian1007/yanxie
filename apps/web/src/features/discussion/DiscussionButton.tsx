import { useMeUser } from '@/lib/session';
import { discussionKey, useDiscussionReading } from './reading-store';
import { useLocation, useNavigate, useParams } from 'react-router';
import { MessagesSquare } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { discussionParams } from './links';
import { tr } from '@/lib/i18n';

export function DiscussionButton({ threadId }: { threadId?: string | null }) {
  const location = useLocation();
  const { projectId = '' } = useParams();
  const me = useMeUser();
  const key = discussionKey(me?.id, projectId, threadId ?? null);
  const unread = useDiscussionReading((s) =>
    Boolean(s.latest[key] && s.latest[key] !== s.seen[key]),
  );
  const navigate = useNavigate();
  return (
    <IconButton
      label={unread ? tr('团队讨论，有新消息') : tr('团队讨论')}
      data-discussion-trigger="true"
      className="max-md:size-11"
      onClick={() =>
        navigate({
          pathname: location.pathname,
          search: `?${discussionParams(location.search, threadId ?? 'project')}`,
        })
      }
    >
      {unread && (
        <span
          aria-hidden
          className="absolute right-1 top-1 size-1.5 rounded-full bg-accent-solid"
        />
      )}
      <MessagesSquare strokeWidth={1.75} aria-hidden />
    </IconButton>
  );
}
