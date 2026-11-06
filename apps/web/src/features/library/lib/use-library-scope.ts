import { useMemo } from 'react';
import { useProjectId } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import type { LibraryScope, PersonalLibrary } from './scope';

export function usePersonalLibrary(): PersonalLibrary {
  const userId = useMeUser()?.id ?? '';
  return useMemo(() => ({ kind: 'personal', userId }), [userId]);
}

export function useLibraryScope(): LibraryScope {
  const pid = useProjectId();
  const personal = usePersonalLibrary();
  return pid || personal;
}
