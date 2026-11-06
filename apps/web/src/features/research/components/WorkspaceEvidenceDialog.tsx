import { lazy, Suspense } from 'react';
import { Button, Dialog, Select, Skeleton } from '@/components/ui';
import { useResearchRecord } from '../data';
import { ResearchHistory } from './ResearchHistory';
import { tr } from '@/lib/i18n';

const Materials = lazy(() =>
  import('./MaterialsSection').then((m) => ({ default: m.MaterialsSection })),
);
const Excerpts = lazy(() =>
  import('./EvidenceSection').then((m) => ({ default: m.EvidenceSection })),
);
const Codes = lazy(() => import('./CodingSection').then((m) => ({ default: m.CodingSection })));
const Findings = lazy(() =>
  import('./FindingsSection').then((m) => ({ default: m.FindingsSection })),
);

const views = {
  materials: tr('资料'),
  evidence: tr('摘录'),
  coding: tr('编码本'),
  findings: tr('结论'),
} as const;
export type EvidenceView = keyof typeof views | 'history';
export default function WorkspaceEvidenceDialog({
  pid,
  recordId,
  view,
  writable,
  onView,
  onClose,
}: {
  pid: string;
  recordId: string;
  view: EvidenceView;
  writable: boolean;
  onView: (view: EvidenceView) => void;
  onClose: () => void;
}) {
  const needsDetail = view === 'history' || view === 'materials';
  const detail = useResearchRecord(pid, recordId, needsDetail);
  return (
    <Dialog
      open
      title={view === 'history' ? tr('历史内容') : tr('依据与分析')}
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="space-y-4">
        {view !== 'history' && (
          <Select
            aria-label={tr('查看依据与分析')}
            value={view}
            onChange={(e) => onView(e.target.value as EvidenceView)}
          >
            {Object.entries(views).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}
        {needsDetail && detail.isPending ? (
          <Skeleton className="h-32" />
        ) : needsDetail && detail.isError ? (
          <div role="alert" className="space-y-2 text-small text-danger">
            <p>{detail.error.message}</p>
            <Button onClick={() => void detail.refetch()}>{tr('重试')}</Button>
          </div>
        ) : (
          <Suspense fallback={<Skeleton className="h-32" />}>
            {view === 'history' && detail.data && <ResearchHistory detail={detail.data} />}
            {view === 'materials' && detail.data && (
              <Materials pid={pid} record={detail.data.record} writable={writable} />
            )}
            {view === 'evidence' && <Excerpts pid={pid} recordId={recordId} writable={writable} />}
            {view === 'coding' && <Codes pid={pid} recordId={recordId} writable={writable} />}
            {view === 'findings' && <Findings pid={pid} recordId={recordId} writable={writable} />}
          </Suspense>
        )}
      </div>
    </Dialog>
  );
}
