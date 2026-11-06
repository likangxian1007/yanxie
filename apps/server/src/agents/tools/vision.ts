import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { isId } from '@srh/shared';
import { readPaperPdf, findPaper } from '../../modules/library/service';
import { readPlainNotebook } from '../../modules/notebooks/service';
import { diskPath, getFile, getFileByPath, MAX_FILE_BYTES } from '../../modules/files/service';
import { describeImage } from '../vision';
import { encodePng } from '../vision/png';
import {
  normalizeRegion,
  PdfRenderError,
  renderPdfPage,
  type PageRegion,
} from '../vision/pdf-render';
import { agentViewer } from './viewer';
import { ALL_ROLES, defineTool, ToolError, type ToolContext } from './types';

/**
 * view_image：读图。项目文件 / 消息附件（file id 或路径）、notebook 图像输出
 * （notebook:<id>#cell<N>/out<M>）、论文 PDF 某页的图（paper:<id>#p<N>，可加 /img<K>；
 * 没有内嵌位图时整页渲染，/page 强制整页，/region:x0,y0,x1,y1 渲染局部）。
 * 有视觉模型（VISION_MODEL）时看图回答；没有时 OCR 识别文字并如实说明。
 */

interface LoadedImage {
  bytes: Buffer;
  mime: string;
  label: string;
  extra?: Record<string, unknown>;
}

const NB_REF = /^notebook:([^#\s]+)#cell(\d+)\/out(\d+)$/u;
const PAPER_REF = /^paper:([^#\s]+)#p(\d+)(?:\/img(\d+)|\/(page)|\/region:([0-9.,\s]+))?$/u;

function b64(v: unknown): string {
  return Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '';
}

async function loadFile(tc: ToolContext, ref: string): Promise<LoadedImage> {
  const row = isId('file', ref)
    ? await getFile(tc.ctx, tc.project.id, ref)
    : await getFileByPath(tc.ctx, tc.project.id, ref);
  if (!row) throw new ToolError(`找不到文件 ${ref}`);
  if (!row.mime.startsWith('image/')) {
    throw new ToolError(`${row.path} 不是图片（${row.mime}），文本文件用 read_file`);
  }
  if (row.mime === 'image/svg+xml') {
    throw new ToolError('SVG 是文本格式的矢量图，用 read_file 读源码');
  }
  if (row.size > MAX_FILE_BYTES) throw new ToolError('图片太大');
  let bytes: Buffer;
  try {
    bytes = await readFile(diskPath(tc.ctx, tc.project.id, row.path));
  } catch {
    throw new ToolError('文件内容已丢失');
  }
  return { bytes, mime: row.mime, label: row.path, extra: { file_id: row.id, path: row.path } };
}

async function loadNotebook(tc: ToolContext, m: RegExpMatchArray): Promise<LoadedImage> {
  const [, id, cellS, outS] = m;
  const { nb } = await readPlainNotebook(tc.ctx, tc.project.id, id!).catch(() => {
    throw new ToolError(`找不到 notebook ${id}`);
  });
  const cell = nb.cells[Number(cellS)];
  const out = cell?.outputs[Number(outS)];
  if (!cell || !out) throw new ToolError(`notebook ${id} 里没有 cell${cellS}/out${outS}`);
  if (out.output_type !== 'display_data' && out.output_type !== 'execute_result') {
    throw new ToolError('这个输出不是图像');
  }
  const png = b64(out.data['image/png']);
  const jpeg = b64(out.data['image/jpeg']);
  if (!png && !jpeg) {
    throw new ToolError(out.data['image/svg+xml'] ? 'SVG 图像暂不支持读取' : '这个输出不是图像');
  }
  return {
    bytes: Buffer.from(png || jpeg, 'base64'),
    mime: png ? 'image/png' : 'image/jpeg',
    label: m[0],
    extra: { notebook_id: id, cell: Number(cellS), output: Number(outS) },
  };
}

async function loadPaper(tc: ToolContext, m: RegExpMatchArray): Promise<LoadedImage> {
  const [, ref, pageS, imgS, pageMode, regionS] = m;
  const row = await findPaper(tc.ctx, tc.project.id, ref!, await agentViewer(tc));
  if (!row) throw new ToolError(`文献库里没有 ${ref}`);
  const pdf = await readPaperPdf(tc.ctx, row);
  if (!pdf) throw new ToolError('这篇论文没有 PDF');
  const page = Number(pageS);
  const base = { paper_id: row.id, citekey: row.citekey, page };
  // 整页 / 区域渲染：矢量图（matplotlib、TikZ 导出）只能这样看
  const render = async (region: PageRegion | null, why?: string): Promise<LoadedImage> => {
    let r: Awaited<ReturnType<typeof renderPdfPage>>;
    try {
      // 拷一份：pdf.js 会 transfer/detach 传入的 buffer
      r = await renderPdfPage(new Uint8Array(pdf), page, region);
    } catch (err) {
      if (err instanceof PdfRenderError) throw new ToolError(err.message);
      throw err;
    }
    return {
      bytes: r.png,
      mime: 'image/png',
      label: m[0],
      extra: {
        ...base,
        rendered: region ? 'region' : 'page',
        ...(region ? { region } : {}),
        pages: r.pages,
        ...(why ? { hint: why } : {}),
      },
    };
  };
  if (pageMode) return render(null);
  if (regionS !== undefined) {
    const nums = regionS.split(',').map((s) => Number(s.trim()));
    try {
      return await render(normalizeRegion(nums));
    } catch (err) {
      if (err instanceof PdfRenderError) throw new ToolError(err.message);
      throw err;
    }
  }
  const { extractImages, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  let images: Awaited<ReturnType<typeof extractImages>>;
  try {
    if (page < 1 || page > doc.numPages)
      throw new ToolError(`页码超出范围（共 ${doc.numPages} 页）`);
    images = await extractImages(doc, page);
  } finally {
    await (doc as unknown as { cleanup?: () => Promise<unknown> })
      .cleanup?.()
      ?.catch?.(() => undefined);
  }
  // 太小的多半是图标 / 公式碎片
  const big = images.filter((i) => i.width >= 64 && i.height >= 64);
  if (!big.length) {
    if (imgS) throw new ToolError(`第 ${page} 页没有内嵌的位图，用 #p${page}/page 看整页渲染`);
    // 没有位图：多半是矢量图，整页渲染
    return render(
      null,
      '这页没有内嵌位图，已整页渲染。图太小看不清时用 #p<页>/region:x0,y0,x1,y1（0–1 比例，左上为原点）只看图所在区域',
    );
  }
  big.sort((a, b) => b.width * b.height - a.width * a.height);
  const k = imgS ? Number(imgS) : 0;
  const pick = big[k];
  if (!pick)
    throw new ToolError(`第 ${page} 页只有 ${big.length} 张图（img0…img${big.length - 1}）`);
  return {
    bytes: encodePng(pick.data, pick.width, pick.height, pick.channels),
    mime: 'image/png',
    label: m[0],
    extra: {
      ...base,
      image: k,
      images_on_page: big.length,
    },
  };
}

export const viewImage = defineTool({
  name: 'view_image',
  description:
    '查看图片（你本身看不到图，图片要用这个工具读）：项目文件或消息附件（path_or_id 给路径或 file id，或用 message_file_id）、' +
    'notebook 图像输出（path_or_id="notebook:<id>#cell<N>/out<M>"，read_notebook 的输出里有 ref）、' +
    '论文某页的图（"paper:<id 或 citekey>#p<页>"：有内嵌位图取最大那张，可加 /img<K> 选第几张；' +
    '没有位图的矢量图会自动整页渲染；"#p<页>/page" 强制整页渲染；"#p<页>/region:x0,y0,x1,y1" 只渲染页上一块区域，' +
    '0–1 比例、左上为原点，例如右上四分之一是 region:0.5,0,1,0.5，图小或要读刻度时用它放大）。question 写你想从图里知道什么。' +
    '配置了视觉模型时返回看图的描述；否则返回 OCR 识别出的文字（mode=ocr，只有文字、看不出曲线走势），回答时要如实说明。',
  roles: ALL_ROLES,
  schema: z.object({
    path_or_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        '文件路径 / file id / notebook:<id>#cell<N>/out<M> / paper:<id>#p<N>[/img<K>|/page|/region:x0,y0,x1,y1]',
      ),
    message_file_id: z.string().min(1).optional().describe('消息附件的 file id'),
    question: z.string().max(1000).optional().describe('想从图里知道什么'),
  }),
  async run(tc, args) {
    const ref = (args.path_or_id ?? args.message_file_id ?? '').trim();
    if (!ref) throw new ToolError('请给 path_or_id 或 message_file_id');
    const nb = NB_REF.exec(ref);
    const paper = PAPER_REF.exec(ref);
    const img = nb
      ? await loadNotebook(tc, nb)
      : paper
        ? await loadPaper(tc, paper)
        : await loadFile(tc, ref);
    await tc.setActivity('在看图');
    const d = await describeImage(tc.ctx, {
      projectId: tc.project.id,
      bytes: img.bytes,
      mime: img.mime,
      label: img.label,
      payerUserId: tc.requesterUserId,
      ...(args.question ? { question: args.question } : {}),
    });
    return {
      ref,
      ...img.extra,
      mode: d.mode,
      width: d.width,
      height: d.height,
      format: d.format,
      ...(d.model ? { model: d.model } : {}),
      ...(d.confidence != null ? { ocr_confidence: d.confidence } : {}),
      ...(d.mode === 'vision' ? { description: d.text } : { ocr_text: d.text }),
      note: d.note,
      ...(d.cached ? { cached: true } : {}),
    };
  },
});

export const visionTools = [viewImage];
