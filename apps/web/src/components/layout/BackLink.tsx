import { Link } from 'react-router';
import { useListReturnHref } from './list-return';
import { ArrowLeft } from 'lucide-react';

export function BackLink({ to, children }: { to: string; children: string }) {
  const href = useListReturnHref(to);
  return (
    <Link
      to={href}
      className="inline-flex min-h-8 items-center gap-1 rounded-xs text-small text-fg-muted transition-colors duration-(--dur-fast) hover:text-fg max-md:min-h-11"
    >
      <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
      {children}
    </Link>
  );
}
