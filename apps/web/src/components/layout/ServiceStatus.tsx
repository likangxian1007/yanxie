import { StatusDot } from '@/components/ui';
import type { ServiceStatusInfo } from './use-service-status';
import { tr } from '@/lib/i18n';

/** 帮助中心中的服务诊断。 */
export function ServiceStatusDetails({ info }: { info: ServiceStatusInfo }) {
  return (
    <details
      id="service-status"
      className="mb-6 scroll-mt-20 rounded-lg border border-line bg-surface"
    >
      <summary className="cursor-pointer px-4 py-3 text-small font-medium text-fg max-sm:min-h-11">
        {tr('服务状态')}
      </summary>
      <div className="border-t border-line px-4 py-3 text-small">
        <p className="flex items-center gap-2 text-fg" role="status">
          <StatusDot status={info.status} label={info.text} aria-hidden />
          <span>{info.text}</span>
        </p>
        <p className="mt-1 text-fg-muted">{info.detail}</p>
      </div>
    </details>
  );
}
