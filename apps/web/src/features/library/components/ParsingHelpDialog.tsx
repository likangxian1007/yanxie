import type { PaperDetail } from '@srh/shared';
import { Button, Dialog } from '@/components/ui';
import { useLibraryStatus } from '../api';
import type { LibraryScope } from '../lib/scope';
import { tr } from '@/lib/i18n';

export function ParsingHelpDialog({
  scope,
  paper,
  onClose,
}: {
  scope: LibraryScope;
  paper: Pick<PaperDetail, 'status' | 'parser' | 'error'>;
  onClose: () => void;
}) {
  const status = useLibraryStatus(scope);
  const textReady = paper.status === 'ready' && paper.parser === 'pdf-text';
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={tr('论文解析帮助')}
      size="md"
      footer={
        <>
          <Button
            variant="secondary"
            loading={status.isFetching}
            onClick={() => void status.refetch()}
          >
            {tr('检查服务连接')}
          </Button>
          <Button onClick={onClose}>{tr('知道了')}</Button>
        </>
      }
    >
      <div className="space-y-4 text-small text-fg-muted">
        <p>
          {textReady
            ? tr(
                '这篇论文已提取出正文。你可以继续阅读、划词翻译和基于正文提问，但目前没有自动识别的章节、公式和图表结构。翻译与问答还需要配置可用的模型。',
              )
            : tr(
                '本次解析没有正常完成。请查看下方原始原因；服务无法连接、文件损坏和扫描图片都需要分别处理。',
              )}
        </p>
        <div className="rounded-md border border-line bg-subtle p-3" role="status">
          <p className="font-medium text-fg">
            {status.isFetching
              ? tr('正在检查结构解析服务…')
              : status.isError
                ? tr('暂时无法获取服务状态')
                : status.data?.reachable
                  ? tr('结构解析服务已连接')
                  : tr('结构解析服务未连接')}
          </p>
          {status.isError ? (
            <p className="mt-1">{status.error.message}</p>
          ) : (
            status.data && (
              <p className="mt-1 break-all">
                {status.data.parser.toUpperCase()} · {status.data.url}
              </p>
            )
          )}
        </div>
        <p>
          {status.data?.parser === 'mineru'
            ? tr('当前版本尚未接入 MinerU。请让管理员改用已接入的 GROBID 服务。')
            : tr(
                'GROBID 是独立的结构解析服务，配置模型 API 不会启动它。请让管理员启动本地服务并确认应用能够连接，再点击“检查服务连接”。',
              )}
          {tr(
            '服务恢复后，有编辑权限的成员可以关闭此窗口，在论文“更多操作”中选择“重新解析”。已有论文不会自动重新解析。',
          )}
        </p>
        <p>
          {tr(
            '如果 PDF 是扫描图片，需要先做 OCR（把图片中的字识别为可选文字），再上传带文字层的 PDF。GROBID 本身不能替代 OCR，也不能保证完整恢复所有公式和表格。',
          )}
        </p>
        {paper.error && (
          <details className="rounded-md border border-line p-3">
            <summary className="cursor-pointer text-fg">{tr('查看本次解析的原始原因')}</summary>
            <p className="mt-2 whitespace-pre-wrap break-words">{paper.error}</p>
          </details>
        )}
      </div>
    </Dialog>
  );
}
