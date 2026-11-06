import { ThreadPanel } from '@/features/coordinator/components/ThreadPanel';
import { usePanelThreads } from '@/features/coordinator/use-panel-threads';

export function RightPanelThreads({
  projectId,
  selectedId,
  onSelect,
}: {
  projectId: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const data = usePanelThreads(projectId);
  return (
    <ThreadPanel projectId={projectId} data={data} selectedId={selectedId} onSelect={onSelect} />
  );
}
