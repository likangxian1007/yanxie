import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { ResearchItemSummary } from '@srh/shared';
import { WorkspaceLayoutCoordinator, type LayoutSave, type LayoutSaved } from './workspace-layout';

export function useWorkspaceLayout({
  items,
  save,
  onSaved,
}: {
  items: ResearchItemSummary[];
  save: LayoutSave;
  onSaved?: (result: LayoutSaved) => void;
}) {
  const [instance] = useState(() => new WorkspaceLayoutCoordinator(items, save, onSaved));
  useLayoutEffect(() => instance.configure(save, onSaved), [instance, save, onSaved]);
  const snapshot = useSyncExternalStore(
    instance.subscribe,
    instance.getSnapshot,
    instance.getSnapshot,
  );
  useEffect(() => instance.ingest(items), [instance, items]);
  return {
    ...snapshot,
    moveMany: instance.moveMany,
    retry: instance.retry,
    resolveMine: instance.resolveMine,
    resolveTheirs: instance.resolveTheirs,
  };
}
