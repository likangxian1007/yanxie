import { ListToolbar } from '@/components/layout/ListToolbar';
import { Search, X } from 'lucide-react';
import { Button, Input, Select } from '@/components/ui';
import { useAssigneeOptions } from '@/features/collab-kit/assignees';
import { isFilterActive, type CardFilter } from '../lib/filter';
import { tr } from '@/lib/i18n';

export interface BoardFilterBarProps {
  pid: string;
  filter: CardFilter;
  onChange: (filter: CardFilter) => void;
  labels: string[];
  shown: number;
  total: number;
}

/** 筛选条：搜索标题、按指派（我的 / 某成员 / agent）、按标签 */
export function BoardFilterBar({
  pid,
  filter,
  onChange,
  labels,
  shown,
  total,
}: BoardFilterBarProps) {
  const { options } = useAssigneeOptions(pid);
  const people = options.filter((o) => o.kind === 'user');
  const agents = options.filter((o) => o.kind === 'agent');
  const active = isFilterActive(filter);

  return (
    <ListToolbar
      className="mb-4"
      search={
        <Input
          type="search"
          size="sm"
          wrapperClassName="w-full sm:w-56"
          leading={<Search strokeWidth={1.75} aria-hidden />}
          placeholder={tr('搜索卡片标题')}
          aria-label={tr('搜索卡片标题')}
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
        />
      }
      filters={
        <>
          <Select
            size="sm"
            wrapperClassName="min-w-0 flex-1 sm:w-40 sm:flex-none"
            aria-label={tr('按指派筛选')}
            value={filter.assignee}
            onChange={(e) => onChange({ ...filter, assignee: e.target.value })}
          >
            <option value="">{tr('全部指派')}</option>
            <option value="me">{tr('我的')}</option>
            <option value="agents">{tr('指派给 agent')}</option>
            <option value="none">{tr('未指派')}</option>
            {people.length > 0 && (
              <optgroup label={tr('成员')}>
                {people.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="AI agent">
              {agents.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          </Select>
          <Select
            size="sm"
            wrapperClassName="min-w-0 flex-1 sm:w-36 sm:flex-none"
            aria-label={tr('按标签筛选')}
            value={filter.label}
            onChange={(e) => onChange({ ...filter, label: e.target.value })}
          >
            <option value="">{tr('全部标签')}</option>
            {labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
            {filter.label && !labels.includes(filter.label) && (
              <option value={filter.label}>{filter.label}</option>
            )}
          </Select>
          {active && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X strokeWidth={1.75} aria-hidden />}
              onClick={() => onChange({ query: '', assignee: '', label: '' })}
            >
              {tr('清除筛选')}
            </Button>
          )}
        </>
      }
      activeFilterCount={Number(Boolean(filter.assignee)) + Number(Boolean(filter.label))}
      actions={
        <span
          className="ml-auto hidden text-caption text-fg-subtle tabular-nums sm:inline"
          aria-live="polite"
        >
          {active
            ? tr('显示 {shown} / {total} 张卡片', { shown, total })
            : tr('{total} 张卡片', { total })}
        </span>
      }
    />
  );
}
