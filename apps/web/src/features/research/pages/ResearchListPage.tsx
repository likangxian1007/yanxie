import { clientId } from '@/lib/client-id';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { AlertTriangle, Microscope, Plus, Search, SearchX } from 'lucide-react';
import type { ResearchResourceRef } from '@srh/shared';
import { Page, PageActions, PageTitle } from '@/components/layout/Page';
import { ListToolbar } from '@/components/layout/ListToolbar';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  RelativeTime,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { useListQueryState, useListStateScope } from '@/lib/list-state';
import { useQueryClient } from '@tanstack/react-query';
import { researchKey, useResearchEvents, useResearchList } from '../data';
import { filterResearchList, researchItemHref } from '../lib/list';
import { ResourcePicker } from '../components/ResourcePicker';
import { workspaceApi } from '../workspace-data';
import { tr } from '@/lib/i18n';

const STATUS_LABEL: Record<string, string> = {
  planned: tr('计划中'),
  active: tr('推进中'),
  paused: tr('已暂停'),
  completed: tr('已完成'),
  abandoned: tr('已放弃'),
};

export function ResearchWorkspacesPage() {
  const pid = useProjectId();
  const writable = canWrite(useMyRole(pid));
  const query = useResearchList(pid);
  useResearchEvents(pid);
  useListStateScope('research');
  const [search, setSearch] = useListQueryState('q', '');
  const [status, setStatus] = useListQueryState('status', 'all');
  const [sort, setSort] = useListQueryState('sort', 'newest');
  const [creating, setCreating] = useState(false);
  const spaces = useMemo(
    () => (query.data ?? []).filter((row) => row.kind === 'research'),
    [query.data],
  );
  const rows = useMemo(
    () =>
      filterResearchList(spaces, {
        query: search,
        status,
        sort: sort === 'oldest' || sort === 'title' ? sort : 'newest',
      }),
    [spaces, search, status, sort],
  );

  return (
    <Page width="full">
      <PageTitle>{tr('研究空间')}</PageTitle>
      <PageActions>
        {writable && (
          <Button variant="primary" leftIcon={<Plus size={16} />} onClick={() => setCreating(true)}>
            {tr('新建研究')}
          </Button>
        )}
      </PageActions>
      {spaces.length > 0 && (
        <ListToolbar
          className="mb-4"
          search={
            <Input
              type="search"
              aria-label={tr('搜索研究空间')}
              placeholder={tr('搜索研究')}
              leading={<Search size={16} />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          }
          filters={
            <>
              <Select
                aria-label={tr('按状态筛选')}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                wrapperClassName="w-auto min-w-28"
              >
                <option value="all">{tr('全部状态')}</option>
                {Object.entries(STATUS_LABEL).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={tr('排序')}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                wrapperClassName="w-auto min-w-28"
              >
                <option value="newest">{tr('最近更新')}</option>
                <option value="oldest">{tr('最早更新')}</option>
                <option value="title">{tr('按标题')}</option>
              </Select>
            </>
          }
          activeFilterCount={Number(status !== 'all')}
        />
      )}
      {query.isPending ? (
        <div role="status" aria-label={tr('正在加载研究空间')} className="space-y-2">
          {[1, 2, 3, 4].map((n) => (
            <Skeleton key={n} className="h-16" />
          ))}
        </div>
      ) : query.isError ? (
        <EmptyState
          framed
          icon={AlertTriangle}
          title={tr('研究空间没有加载出来')}
          description={query.error.message}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : spaces.length === 0 ? (
        <EmptyState
          framed
          icon={Microscope}
          title={tr('还没有研究空间')}
          action={
            writable ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                {tr('新建研究')}
              </Button>
            ) : undefined
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={tr('没有符合条件的研究')}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setSearch('');
                setStatus('all');
              }}
            >
              {tr('清除筛选')}
            </Button>
          }
        />
      ) : (
        <ul
          className="divide-y divide-line rounded-lg border border-line bg-surface"
          aria-label={tr('研究空间列表')}
        >
          {rows.map((row) => (
            <li key={`${row.kind}:${row.id}`} data-list-item={row.id} className="min-w-0">
              <Link
                to={researchItemHref(pid, row)}
                className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-subtle focus-visible:bg-subtle"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium text-fg">{row.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-caption text-fg-muted">
                    <RelativeTime iso={row.updatedAt} />
                  </div>
                </div>
                <Badge tone={row.status === 'completed' ? 'success' : 'neutral'}>
                  {STATUS_LABEL[row.status] ?? row.status}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating && <NewResearchDialog open onOpenChange={setCreating} pid={pid} />}
    </Page>
  );
}

function NewResearchDialog({
  open,
  onOpenChange,
  pid,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pid: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [addingResource, setAddingResource] = useState(false);
  const [resource, setResource] = useState<ResearchResourceRef | null>(null);
  const [resourceTitle, setResourceTitle] = useState('');
  const [createdId, setCreatedId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [createKey] = useState(() => clientId());
  const [itemKey] = useState(() => clientId());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (addingResource && !resource?.id) {
      setError(tr('请选择材料，或关闭材料选择。'));
      return;
    }
    setPending(true);
    setError('');
    try {
      const record = createdId
        ? { id: createdId }
        : await workspaceApi.create(pid, {
            ...(title.trim() ? { title: title.trim() } : {}),
            question: question.trim(),
            idempotencyKey: createKey,
          });
      setCreatedId(record.id);
      if (addingResource && resource?.id) {
        await workspaceApi.createItem(pid, record.id, {
          kind: 'resource',
          title: resourceTitle.trim() || tr('关联资料'),
          resource,
          idempotencyKey: itemKey,
        });
      }
      await qc.invalidateQueries({ queryKey: researchKey(pid) });
      onOpenChange(false);
      navigate(`/p/${pid}/research/${record.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('创建失败，请重试。'));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tr('新建研究')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button variant="primary" type="submit" form="research-new-record" loading={pending}>
            {createdId ? tr('重试关联') : tr('创建研究')}
          </Button>
        </>
      }
    >
      <form id="research-new-record" className="space-y-4" onSubmit={submit}>
        <label className="block space-y-1.5 text-small text-fg">
          {tr('名称')}
          <Input
            value={title}
            maxLength={200}
            autoFocus
            disabled={!!createdId}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tr('未命名研究')}
          />
        </label>
        <label className="block space-y-1.5 text-small text-fg">
          {tr('研究问题')}
          <Textarea
            value={question}
            maxLength={5000}
            rows={3}
            disabled={!!createdId}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={tr('可以稍后补充')}
          />
        </label>
        {!addingResource ? (
          <Button variant="secondary" size="sm" onClick={() => setAddingResource(true)}>
            {tr('关联材料')}
          </Button>
        ) : (
          <div className="space-y-2">
            <ResourcePicker
              pid={pid}
              value={resource}
              onChange={setResource}
              label={tr('材料')}
              allowUpload
              onUploadTitle={(name) =>
                setResourceTitle((current) => (current.trim() ? current : name.slice(0, 200)))
              }
            />
            <Input
              aria-label={tr('材料名称')}
              value={resourceTitle}
              onChange={(e) => setResourceTitle(e.target.value)}
              placeholder={tr('材料名称（可稍后修改）')}
            />
            {!createdId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAddingResource(false);
                  setResource(null);
                }}
              >
                {tr('暂不关联')}
              </Button>
            )}
          </div>
        )}
        {createdId && (
          <p className="text-small text-fg-muted">
            {tr('研究已创建，材料关联未完成。可重试，或先打开研究。')}
          </p>
        )}
        {createdId && (
          <Button variant="secondary" onClick={() => navigate(`/p/${pid}/research/${createdId}`)}>
            {tr('打开研究')}
          </Button>
        )}
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

export { ResearchWorkspacesPage as ResearchListPage };
