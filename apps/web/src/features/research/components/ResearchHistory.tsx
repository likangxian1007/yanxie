import type { ResearchFieldValue, ResearchRecordDetail } from '@srh/shared';
import { RelativeTime } from '@/components/ui';
import { tr, trServer } from '@/lib/i18n';

function valueText(value: ResearchFieldValue): string {
  if (value === null) return '';
  if (typeof value !== 'object') return String(value);
  if ('value' in value) return `${value.value} ${value.unit}`;
  return `${value.kind}: ${value.id}`;
}

/** 历史内容是原数据的只读投影；不复制、不改写，也不恢复旧填写流程。 */
export function ResearchHistory({ detail }: { detail: ResearchRecordDetail }) {
  const { record, template, logs } = detail;
  const fields = Object.entries(record.fieldValues).filter(
    ([, value]) => value !== null && value !== '',
  );
  const steps = Object.entries(record.stepState);
  const hasContent = fields.length || steps.length || record.resources.length || logs.length;
  return (
    <div className="space-y-6 text-small text-fg">
      <p className="text-caption text-fg-muted">
        {tr('内容版本 {version} · 历史内容只读，继续研究请在空间中编辑笔记和材料。', {
          version: record.version,
        })}
      </p>
      {!hasContent && <p className="text-fg-muted">{tr('暂无早期内容。')}</p>}
      {!!fields.length && (
        <dl className="divide-y divide-line">
          {fields.map(([id, value]) => (
            <div key={id} className="space-y-1 py-3">
              <dt className="font-medium">
                {template.fields.find((field) => field.id === id)?.label ?? id}
              </dt>
              <dd className="whitespace-pre-wrap break-words text-prose">{valueText(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {!!record.resources.length && (
        <section className="space-y-2" aria-label={tr('早期资料引用')}>
          <h3 className="font-medium">{tr('资料引用')}</h3>
          {record.resources.map((resource, index) => (
            <p key={index} className="break-all">
              {resource.kind}: {resource.id}
            </p>
          ))}
        </section>
      )}
      {!!steps.length && (
        <section className="space-y-2" aria-label={tr('早期进展')}>
          <h3 className="font-medium">{tr('早期进展')}</h3>
          {steps.map(([id, done]) => {
            const report = record.stepReports[id];
            return (
              <div key={id} className="space-y-1 border-b border-line py-2">
                <p>
                  {template.steps.find((step) => step.id === id)?.title ?? id} ·{' '}
                  {done ? tr('报告完成') : tr('未完成')}
                </p>
                <p className="text-caption text-fg-muted">
                  {report
                    ? tr('{name} · {value} · 未核验', {
                        name: trServer(report.reportedBy.name),
                        value: report.origin === 'agent_work' ? tr('AI 工作') : tr('成员报告'),
                      })
                    : tr('未核验；未保存报告者')}
                </p>
              </div>
            );
          })}
        </section>
      )}
      {!!logs.length && (
        <section className="space-y-2" aria-label={tr('历史过程')}>
          <h3 className="font-medium">{tr('历史过程')}</h3>
          {logs.map((log) => (
            <div key={log.id} className="space-y-1 border-b border-line py-2">
              <p className="text-caption text-fg-muted">
                {trServer(log.createdBy.name)} · <RelativeTime iso={log.createdAt} />
              </p>
              <p className="whitespace-pre-wrap break-words text-prose">{log.body}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
