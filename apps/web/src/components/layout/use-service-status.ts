import type { StatusBucket } from '@srh/shared';
import { DB_DRIVER_LABEL, useHealth } from '@/lib/health';
import { tr } from '@/lib/i18n';

export interface ServiceStatusInfo {
  status: StatusBucket;
  text: string;
  detail: string;
}

/** 把健康检查结果翻译成状态点 + 中文文案。 */
export function useServiceStatus(): ServiceStatusInfo {
  const { data, isPending, isError } = useHealth();
  if (isPending) {
    return { status: 'idle', text: tr('正在连接服务…'), detail: tr('正在检查服务状态') };
  }
  if (isError) {
    return {
      status: 'failed',
      text: tr('服务异常'),
      detail: tr('暂时连不上服务，请检查网络；系统会自动重试。'),
    };
  }
  const driver = DB_DRIVER_LABEL[data.db.driver] ?? data.db.driver;
  if (data.status !== 'ok' || !data.db.ok) {
    return {
      status: 'failed',
      text: tr('服务异常'),
      detail: tr('数据库（{driver}）暂时不可用，请稍后重试或联系课题负责人。', { driver }),
    };
  }
  const latency =
    data.db.latencyMs === null
      ? ''
      : tr(' · 数据库延迟 {latencyMs}ms', { latencyMs: data.db.latencyMs });
  return {
    status: 'completed',
    text: tr('服务正常'),
    detail: tr('版本 {version} · 数据库 {driver}{latency}', {
      version: data.version,
      driver,
      latency,
    }),
  };
}
