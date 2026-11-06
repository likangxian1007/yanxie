import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { type Project } from '@srh/shared';
import { Button, Input, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PALETTE_NAMES, paletteSoft, paletteVar } from '@/lib/palette';
import { qk } from '@/lib/query-keys';
import { rememberProject } from '@/lib/session';
import { tr } from '@/lib/i18n';

const ICONS = ['🔬', '🧬', '🧪', '📊', '🧠', '🛰️', '⚗️', '📚'];

/** 新建课题表单（/new 页面与侧栏“新建课题”对话框共用）。 */
export function ProjectCreateForm({ onCancel }: { onCancel?: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState(ICONS[0] ?? '🔬');
  const [color, setColor] = useState(0);
  const [domains, setDomains] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(tr('给课题起个名字。'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const project = await api.post<Project>('/projects', {
        name: name.trim(),
        description: description.trim(),
        icon,
        color,
        visibility: 'team',
        researchDomains: domains
          .split(/[，,\n]/u)
          .map((value) => value.trim())
          .filter(Boolean),
      });
      rememberProject(project.id);
      await qc.invalidateQueries({ queryKey: qk.me });
      onCancel?.();
      navigate(`/p/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('创建失败，请稍后再试。'));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <div className="flex items-end gap-3">
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-md text-h2 ring-1 ring-line"
          style={{ backgroundColor: paletteSoft(color) }}
        >
          {icon}
        </span>
        <label className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-small font-medium text-fg">{tr('课题名称')}</span>
          <Input
            data-autofocus
            value={name}
            maxLength={60}
            placeholder={tr('例如：扩散模型用于医学图像分割')}
            error={error ?? undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-small font-medium text-fg">{tr('一句话介绍')}</span>
        <Textarea
          rows={2}
          value={description}
          maxLength={500}
          placeholder={tr('研究什么、目标是什么。协调者会把它当作背景。')}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-small font-medium text-fg">{tr('图标与颜色')}</legend>
        <div className="flex flex-wrap gap-1.5">
          {ICONS.map((i) => (
            <button
              key={i}
              type="button"
              aria-pressed={icon === i}
              aria-label={tr('图标 {i}', { i })}
              onClick={() => setIcon(i)}
              className={cn(
                'press grid size-8 cursor-pointer place-items-center rounded-md text-body',
                icon === i ? 'bg-subtle ring-2 ring-accent' : 'hover:bg-subtle',
              )}
            >
              {i}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label={tr('项目颜色')} className="flex flex-wrap gap-2">
          {PALETTE_NAMES.map((label, i) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={color === i}
              aria-label={label}
              onClick={() => setColor(i)}
              className={cn(
                'press size-6 cursor-pointer rounded-full ring-offset-2 ring-offset-elevated',
                color === i && 'ring-2 ring-fg',
              )}
              style={{ backgroundColor: paletteVar(i) }}
            />
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className="text-small font-medium text-fg">{tr('研究领域（可选）')}</span>
        <Input
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          placeholder={tr('例如：公共卫生、信息科学')}
        />
      </label>

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {tr('取消')}
          </Button>
        )}
        <Button type="submit" variant="primary" loading={pending}>
          {tr('创建课题')}
        </Button>
      </div>
    </form>
  );
}
