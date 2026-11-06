import { Link, useParams } from 'react-router';
import { Page, PageHeader } from '@/components/layout/Page';
import { tr } from '@/lib/i18n';
export function RetiredFeaturePage() {
  const { projectId } = useParams();
  return (
    <Page width="doc">
      <PageHeader title={tr('内容已移除')} />
      <p className="mb-4 text-body text-fg-muted">
        {tr('实验与云电脑功能已移除。请在研究空间继续开展研究。')}
      </p>
      <Link className="text-accent underline" to={`/p/${projectId}/research`}>
        {tr('打开研究空间')}
      </Link>
    </Page>
  );
}
