import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ListTodo, Plus, X } from 'lucide-react';
import { Button, Dialog, EmptyState, IconButton, Input, Select, toast } from '@/components/ui';
import { useAssigneeOptions } from '@/features/collab-kit/assignees';
import { useCreateReportTodos } from '../api';
import {
  extractPlanEntries,
  matchAssignee,
  MAX_PLAN_ITEMS,
  MAX_PLAN_TITLE,
} from '../lib/plan-items';
import { tr } from '@/lib/i18n';

interface Row {
  key: number;
  title: string;
  checked: boolean;
  /** null = 还没手动选过，按正文里的负责人自动预填 */
  assigneeId: string | null;
  owner: string | null;
}

/**
 * 拆成待办：从正文“下周计划 / 下期计划 / Next steps”小节抽出条目，可勾选、改标题、选指派人。
 * 父组件每次打开时用新的 key 挂载，条目按当时的正文重新抽取。
 */
export function PlanTodosDialog({
  pid,
  reportId,
  content,
  open,
  onOpenChange,
}: {
  pid: string;
  reportId: string;
  content: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const assignees = useAssigneeOptions(pid);
  const create = useCreateReportTodos(pid, reportId);
  const [rows, setRows] = useState<Row[]>(() =>
    extractPlanEntries(content).map((item, i) => ({
      key: i,
      title: item.title,
      owner: item.owner,
      checked: true,
      assigneeId: null,
    })),
  );
  const [nextKey, setNextKey] = useState(rows.length);

  const options = useMemo(
    () => [
      { value: '', label: tr('不指派') },
      ...assignees.options.map((o) => ({
        value: o.value,
        label: o.kind === 'agent' ? tr('{label}（agent）', { label: o.label }) : o.label,
      })),
    ],
    [assignees.options],
  );
  /** 正文写了「负责人X」/ @X：匹配到唯一的成员或 agent 就预填 */
  const assigneeOf = (r: Row) => r.assigneeId ?? matchAssignee(r.owner, assignees.options) ?? '';

  const selected = rows.filter((r) => r.checked && r.title.trim());
  const patch = (key: number, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const addRow = () => {
    setRows((rs) => [
      ...rs,
      { key: nextKey, title: '', checked: true, assigneeId: '', owner: null },
    ]);
    setNextKey((k) => k + 1);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (selected.length === 0) return;
    create.mutate(
      selected.map((r) => ({ title: r.title.trim(), assigneeId: assigneeOf(r) || null })),
      {
        onSuccess: (n) => {
          onOpenChange(false);
          toast({
            title: tr('已创建 {n} 条待办', { n }),
            description: tr('来源会标注为这份组会汇报。'),
            tone: 'success',
            action: { label: tr('去待办'), onClick: () => navigate(`/p/${pid}/todos`) },
          });
        },
        onError: (err) => toast.error(tr('没能创建待办'), err.message),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={tr('拆成待办')}
      description={tr(
        '从“下周计划”小节里找到了下面这些条目，勾选要创建的，可以顺手改标题和指派人。',
      )}
      footer={
        rows.length > 0 ? (
          <>
            <span className="mr-auto text-caption text-fg-subtle">
              {tr('已选 {count} 条', { count: selected.length })}
            </span>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {tr('取消')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="plan-todos-form"
              loading={create.isPending}
              disabled={selected.length === 0}
            >
              {tr('创建 {count} 条待办', { count: selected.length })}
            </Button>
          </>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title={tr('没有找到计划条目')}
          description={tr(
            '在正文里加一个“## 下周计划”标题，用列表写出要做的事，再来拆成待办；也可以手动添加。',
          )}
          action={
            <Button leftIcon={<Plus strokeWidth={1.75} aria-hidden />} onClick={addRow}>
              {tr('手动添加一条')}
            </Button>
          }
          className="py-8"
        />
      ) : (
        <form id="plan-todos-form" onSubmit={submit}>
          <ul className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <li
                key={r.key}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface p-2 sm:flex-nowrap"
              >
                <input
                  type="checkbox"
                  checked={r.checked}
                  onChange={(e) => patch(r.key, { checked: e.target.checked })}
                  aria-label={tr('创建第 {value} 条', { value: i + 1 })}
                  className="size-4 shrink-0 cursor-pointer accent-(--accent)"
                />
                <Input
                  size="sm"
                  value={r.title}
                  maxLength={MAX_PLAN_TITLE}
                  placeholder={tr('待办标题')}
                  aria-label={tr('第 {value} 条标题', { value: i + 1 })}
                  onChange={(e) => patch(r.key, { title: e.target.value })}
                  wrapperClassName="min-w-0 flex-1"
                />
                <Select
                  size="sm"
                  value={assigneeOf(r)}
                  aria-label={tr('第 {value} 条指派给', { value: i + 1 })}
                  options={options}
                  onChange={(e) => patch(r.key, { assigneeId: e.target.value })}
                  wrapperClassName="ml-6 w-[calc(100%-1.5rem)] sm:ml-0 sm:w-36 sm:shrink-0"
                />
                <IconButton
                  label={tr('移除这一条')}
                  size="sm"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  className="hidden sm:inline-flex"
                >
                  <X strokeWidth={1.75} aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
          {rows.length < MAX_PLAN_ITEMS && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
              onClick={addRow}
            >
              {tr('添加一条')}
            </Button>
          )}
        </form>
      )}
    </Dialog>
  );
}
