import { memo, useMemo, useState } from 'react';
import { NOTEBOOK_METRICS_MIME, type NbMimeBundle, type NbOutput } from '@srh/shared';
import { cn } from '@/lib/cn';
import { imageMeta, WIDGET_MIME, type ImageMeta } from '../outputs';
import {
  ansiToHtml,
  fixConsole,
  joinText,
  renderMarkdown,
  sanitize,
  sanitizeOutputHtml,
} from '../render';
import { tr } from '@/lib/i18n';

/**
 * 单元格输出区，和 JupyterLab 一样按 MIME 优先级挑最丰富的一种显示：
 * 指标 → HTML → 图片(png/jpeg/svg) → Markdown → LaTeX → JSON → 纯文本。
 * 连续的同名 stream 合并显示；stderr 浅红底；报错显示带颜色的 traceback。
 */
export const CellOutputs = memo(function CellOutputs({ outputs }: { outputs: NbOutput[] }) {
  const merged = useMemo(() => mergeStreams(outputs), [outputs]);
  return (
    <div className="nb-outputs flex min-w-0 flex-col gap-1">
      {merged.map((o, i) => (
        <OutputItem key={i} output={o} />
      ))}
    </div>
  );
});

function mergeStreams(outputs: NbOutput[]): NbOutput[] {
  const out: NbOutput[] = [];
  for (const o of outputs) {
    const prev = out[out.length - 1];
    if (o.output_type === 'stream' && prev?.output_type === 'stream' && prev.name === o.name) {
      out[out.length - 1] = { ...prev, text: joinText(prev.text) + joinText(o.text) };
    } else out.push(o);
  }
  return out;
}

function OutputItem({ output: o }: { output: NbOutput }) {
  if (o.output_type === 'stream') {
    return (
      <pre
        className={`nb-stream ${o.name === 'stderr' ? 'nb-stderr' : ''}`}
        dangerouslySetInnerHTML={{ __html: ansiToHtml(fixConsole(joinText(o.text))) }}
      />
    );
  }
  if (o.output_type === 'error') {
    const tb = o.traceback?.length ? o.traceback.join('\n') : `${o.ename}: ${o.evalue}`;
    return (
      <pre
        className="nb-stream nb-error"
        role="alert"
        dangerouslySetInnerHTML={{ __html: ansiToHtml(tb) }}
      />
    );
  }
  return <MimeBundle data={o.data} metadata={o.metadata} />;
}

function MimeBundle({ data, metadata }: { data: NbMimeBundle; metadata: Record<string, unknown> }) {
  const metrics = data[NOTEBOOK_METRICS_MIME];
  if (metrics && typeof metrics === 'object') return <Metrics value={metrics as MetricsPayload} />;

  if (data[WIDGET_MIME] !== undefined) {
    // ipywidgets / tqdm.notebook：控件状态走 comm 消息，这里没有，只能显示它附带的文本
    const rest = Object.fromEntries(Object.entries(data).filter(([k]) => k !== WIDGET_MIME));
    const plain = joinText(rest['text/plain']);
    const isProgress = /\d+%\|/.test(plain);
    return (
      <div className="nb-widget flex min-w-0 flex-col gap-0.5">
        <p className="text-caption text-fg-subtle">
          {isProgress
            ? tr(
                '交互进度条暂不支持，下面是它开始时的文本，不会自动更新。改用 from tqdm import tqdm 可以看到实时的文本进度条。',
              )
            : tr('交互控件暂不支持，显示文本结果。')}
        </p>
        {Object.keys(rest).length > 0 && <MimeBundle data={rest} metadata={metadata} />}
      </div>
    );
  }

  const html = data['text/html'];
  if (html !== undefined) {
    return (
      <div
        className="nb-html"
        dangerouslySetInnerHTML={{ __html: sanitizeOutputHtml(joinText(html)) }}
      />
    );
  }
  for (const mime of ['image/png', 'image/jpeg', 'image/gif'] as const) {
    const b64 = data[mime];
    if (b64 === undefined) continue;
    return (
      <OutputImage
        src={`data:${mime};base64,${joinText(b64).replace(/\s/g, '')}`}
        meta={imageMeta(metadata, mime)}
      />
    );
  }
  const svg = data['image/svg+xml'];
  if (svg !== undefined) {
    return (
      <div
        className="nb-image nb-svg"
        dangerouslySetInnerHTML={{
          __html: sanitize(joinText(svg).replace(/<\?xml[^>]*>/, '')),
        }}
      />
    );
  }
  const md = data['text/markdown'];
  if (md !== undefined) {
    return (
      <div
        className="nb-markdown"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(joinText(md)) }}
      />
    );
  }
  const latex = data['text/latex'];
  if (latex !== undefined) {
    const t = joinText(latex).trim();
    const body = /^\$|\\\[|\\\(/.test(t) ? t : `$$${t}$$`;
    return (
      <div className="nb-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
    );
  }
  const json = data['application/json'];
  if (json !== undefined) {
    return <pre className="nb-stream">{JSON.stringify(json, null, 2)}</pre>;
  }
  const plain = data['text/plain'];
  if (plain !== undefined) {
    return (
      <pre
        className="nb-stream"
        dangerouslySetInnerHTML={{ __html: ansiToHtml(joinText(plain)) }}
      />
    );
  }
  return (
    <p className="text-caption text-fg-subtle">
      {tr('（无法显示的输出类型：{value}）', { value: Object.keys(data).join(', ') })}
    </p>
  );
}

/**
 * 图片按原始尺寸显示（metadata 里有 width / height 时按它，retina 图因此不会放大一倍），
 * 比容器宽才缩小；缩小了的图点一下看原尺寸（容器横向滚动），再点缩回。
 */
function OutputImage({ src, meta }: { src: string; meta: ImageMeta }) {
  const [canZoom, setCanZoom] = useState(false);
  const [full, setFull] = useState(false);
  const toggle = () => canZoom && setFull((v) => !v);
  return (
    <img
      className={cn(
        'nb-image',
        (full || meta.unconfined) && 'nb-image-full',
        canZoom && 'nb-zoomable',
      )}
      alt={tr('输出图像')}
      src={src}
      width={meta.width}
      height={meta.height}
      loading="lazy"
      {...(canZoom
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-pressed': full,
            title: full ? tr('点击缩回') : tr('点击查看原尺寸'),
            onClick: toggle,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                toggle();
              }
            },
          }
        : {})}
      onLoad={(e) => {
        const img = e.currentTarget;
        const natural = meta.width ?? img.naturalWidth;
        setCanZoom(!meta.unconfined && natural > img.clientWidth + 1);
      }}
    />
  );
}

interface MetricsPayload {
  kind?: 'params' | 'metrics';
  values?: Record<string, number | string>;
  step?: number | null;
}

/** srh.log_param / srh.log_metric 的回显：一排小卡片，保留在 Notebook 单元格输出中 */
function Metrics({ value }: { value: MetricsPayload }) {
  const entries = Object.entries(value.values ?? {});
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-0.5">
      <span className="text-caption text-fg-subtle">
        {value.kind === 'params' ? tr('已记录参数') : tr('已记录指标')}
        {value.step != null ? ` · step ${value.step}` : ''}
      </span>
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex items-baseline gap-1 rounded-md border border-line bg-subtle px-1.5 py-0.5 font-mono text-[12px]"
        >
          <span className="text-fg-muted">{k}</span>
          <span className="font-medium text-fg tabular-nums">
            {typeof v === 'number' ? Number(v.toPrecision(6)) : v}
          </span>
        </span>
      ))}
    </div>
  );
}
