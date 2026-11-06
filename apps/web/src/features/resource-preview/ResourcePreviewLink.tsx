import { Link, useLocation, type LinkProps } from 'react-router';
import { previewHref, rememberPreviewTrigger, type ResourceType } from './links';

export function ResourcePreviewLink({
  type,
  id,
  onClick,
  ...props
}: Omit<LinkProps, 'to' | 'id' | 'type'> & { type: ResourceType; id: string }) {
  const location = useLocation();
  return (
    <Link
      {...props}
      to={previewHref(location, type, id)}
      data-list-item={`${type}:${id}`}
      onClick={(event) => {
        onClick?.(event);
        if (
          !event.defaultPrevented &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.button === 0
        )
          rememberPreviewTrigger(event.currentTarget);
      }}
    />
  );
}
