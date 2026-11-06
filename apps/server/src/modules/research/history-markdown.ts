import type { ResearchRecordDetail } from '@srh/shared';

/** 历史值按原版本回读；空白研究不生成旧模板的字段或步骤清单。 */
export function researchHistoryMarkdown({
  record,
  template,
  logs,
}: Pick<ResearchRecordDetail, 'record' | 'template' | 'logs'>): string {
  const fields = Object.entries(record.fieldValues).filter(
    ([, value]) => value !== null && value !== '',
  );
  const steps = Object.entries(record.stepState);
  if (!fields.length && !steps.length && !logs.length) return '';
  const lines = ['## 历史内容', ''];
  if (fields.length || steps.length)
    lines.push(`原方法版本：${template.name}（${template.id} v${template.version}）`, '');
  for (const [id, value] of fields) {
    const label = template.fields.find((field) => field.id === id)?.label ?? id;
    const text =
      value && typeof value === 'object'
        ? 'value' in value
          ? `${value.value} ${value.unit}`
          : `${value.kind}: ${value.id}`
        : String(value);
    lines.push(`- ${label} [${id}]：${text}`);
  }
  for (const [id, done] of steps) {
    const report = record.stepReports[id];
    lines.push(
      `- ${template.steps.find((step) => step.id === id)?.title ?? id}：${done ? '报告完成' : '未完成'}；${report ? `${report.reportedBy.kind}:${report.reportedBy.name}；${report.origin}；${report.verification}` : 'unverified；未保存报告者'}`,
    );
  }
  for (const log of logs)
    lines.push('', `### ${log.createdAt} · ${log.createdBy.name}`, '', log.body);
  return lines.join('\n');
}
