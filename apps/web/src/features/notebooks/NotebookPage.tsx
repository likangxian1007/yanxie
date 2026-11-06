import { useParams } from 'react-router';
import { Page, PageTitle } from '@/components/layout/Page';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { NotebookById } from './components/NotebookPanel';
export function NotebookPage() {
  const pid = useProjectId();
  const { notebookId = '' } = useParams();
  const role = useMyRole(pid);
  return (
    <Page width="full">
      <PageTitle>Notebook</PageTitle>
      <NotebookById pid={pid} notebookId={notebookId} writable={canWrite(role)} />
    </Page>
  );
}
