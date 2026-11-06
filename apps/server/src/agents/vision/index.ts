import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import type { AppContext } from '../../context';
import { clientFor, projectProviders } from '../llm/registry';
import { OcrUnavailableError, runOcr } from './ocr';
import { assertCanSpend, chargeUsage } from '../../modules/billing/service';

/**
 * 读图（DeepSeek 没有视觉能力）：
 * a) 配置了 VISION_MODEL=<providerId>/<model> 时，用该 OpenAI 兼容模型看图（image_url data URL）回答问题；
 * b) 否则用 OCR 兜底（系统 tesseract 或 tesseract.js，chi_sim+eng），返回识别出的文字 + 尺寸，
 *    并如实说明这只是文字识别、不是视觉理解（看不出曲线走势、颜色、图形结构）。
 * 结果按「图片内容哈希 + 问题哈希」缓存在内存和 STORAGE_DIR/.vision-cache 里
 * （文件被覆盖后内容变了，自然不会命中旧结果；磁盘缓存重启后仍有效）。
 */

export interface DescribeImageInput {
  projectId: string;
  bytes: Buffer;
  mime: string;
  question?: string;
  /** 缓存键的一部分（文件 id、notebook 引用等），只用于日志 */
  label?: string;
  /** 计费：触发人；不传时由项目创建者付 */
  payerUserId?: string | null;
}

export interface ImageDescription {
  mode: 'vision' | 'ocr' | 'unavailable';
  /** vision：模型的描述 / 回答；ocr：识别出的文字 */
  text: string;
  width: number | null;
  height: number | null;
  format: string | null;
  model?: string;
  confidence?: number | null;
  note: string;
  cached?: boolean;
}

const MAX_VISION_BYTES = 15 * 1024 * 1024;
const CACHE_MAX = 200;
const cache = new Map<string, ImageDescription>();

export function imageMeta(bytes: Buffer): {
  width: number | null;
  height: number | null;
  format: string | null;
} {
  try {
    const s = imageSize(bytes);
    return { width: s.width ?? null, height: s.height ?? null, format: s.type ?? null };
  } catch {
    return { width: null, height: null, format: null };
  }
}

/** 解析 VISION_MODEL：精确匹配 provider id + 模型名（不回落到默认模型——默认模型看不了图） */
async function visionTarget(ctx: AppContext, projectId: string) {
  const spec = ctx.config.VISION_MODEL.trim();
  if (!spec) return null;
  const slash = spec.indexOf('/');
  if (slash <= 0) {
    console.warn(
      `[vision] VISION_MODEL 格式应为 <providerId>/<model>，现在是「${spec}」，已改用 OCR`,
    );
    return null;
  }
  const providerId = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  const provider = (await projectProviders(ctx, projectId)).find(
    (p) => p.id === providerId && p.enabled,
  );
  if (!provider) {
    console.warn(`[vision] VISION_MODEL 的 provider「${providerId}」不存在，已改用 OCR`);
    return null;
  }
  return { provider, model, id: spec };
}

function cacheKey(bytes: Buffer, question: string, mode: string): string {
  return createHash('sha256')
    .update(bytes)
    .update('\0')
    .update(question)
    .update('\0')
    .update(mode)
    .digest('hex');
}

/**
 * 磁盘缓存：放在 STORAGE_DIR/.vision-cache（Docker 部署里是 storage 持久卷），
 * 重启 / 重新部署后同一张图同一个问题不用再 OCR 或再调视觉模型。写失败只记日志。
 */
function diskCacheDir(ctx: AppContext): string {
  return join(ctx.config.STORAGE_DIR, '.vision-cache');
}

async function readDisk(ctx: AppContext, key: string): Promise<ImageDescription | null> {
  try {
    const raw = await readFile(join(diskCacheDir(ctx), `${key}.json`), 'utf8');
    const v = JSON.parse(raw) as ImageDescription;
    return v && typeof v.text === 'string' && (v.mode === 'vision' || v.mode === 'ocr') ? v : null;
  } catch {
    return null;
  }
}

async function writeDisk(ctx: AppContext, key: string, v: ImageDescription): Promise<void> {
  try {
    const dir = diskCacheDir(ctx);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${key}.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(v), 'utf8');
    await rename(tmp, join(dir, `${key}.json`));
  } catch (err) {
    console.warn('[vision] 写读图缓存失败：', (err as Error).message);
  }
}

function rememberMem(key: string, v: ImageDescription): ImageDescription {
  cache.set(key, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return v;
}

async function remember(
  ctx: AppContext,
  key: string,
  v: ImageDescription,
): Promise<ImageDescription> {
  rememberMem(key, v);
  await writeDisk(ctx, key, v);
  return v;
}

/** 测试用 */
export function clearVisionCache(): void {
  cache.clear();
}

export async function describeImage(
  ctx: AppContext,
  input: DescribeImageInput,
): Promise<ImageDescription> {
  const meta = imageMeta(input.bytes);
  const question = input.question?.trim() ?? '';
  const target = await visionTarget(ctx, input.projectId);
  const key = cacheKey(input.bytes, question, target?.id ?? 'ocr');
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };
  const disk = await readDisk(ctx, key);
  if (disk) return { ...rememberMem(key, disk), cached: true };

  if (target) {
    if (input.bytes.length > MAX_VISION_BYTES) {
      // 太大就不发给视觉模型，直接走 OCR
      console.warn(`[vision] 图片 ${input.label ?? ''} 超过 15 MB，改用 OCR`);
    } else {
      const providerRef = { id: target.provider.id, source: target.provider.source };
      const billing = {
        payerUserId: input.payerUserId ?? null,
        projectId: input.projectId,
        note: 'vision',
      };
      try {
        // 余额不足时这里抛错，落到下面的 OCR 兜底（OCR 不收费）
        await assertCanSpend(ctx, providerRef, billing);
        const res = await clientFor(target.provider).chat.completions.create({
          model: target.model,
          max_tokens: 1500,
          // OpenRouter：要回实际花费（usage.cost），计费以此为准
          ...(target.provider.thinkingFormat === 'openrouter'
            ? ({ usage: { include: true } } as Record<string, unknown>)
            : {}),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    (question
                      ? `请看这张图，回答：${question}\n`
                      : '请详细描述这张图：类型（照片 / 图表 / 截图 / 示意图…）、图里的文字、坐标轴与图例、数据趋势和关键数值。\n') +
                    '只写图里真实能看到的内容，看不清的说看不清。用中文回答。',
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${input.mime || 'image/png'};base64,${input.bytes.toString('base64')}`,
                  },
                },
              ],
            },
          ],
        });
        // 扣费失败只记日志：调用已经发生，不能因此再走一遍 OCR
        await chargeUsage(ctx, billing, {
          provider: providerRef,
          model: target.model,
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
          costUsd: (res.usage as { cost?: number } | undefined)?.cost ?? null,
        }).catch((err: unknown) => console.error('[billing] vision 扣费失败', err));
        const text = res.choices[0]?.message?.content?.trim() ?? '';
        if (text) {
          return remember(ctx, key, {
            mode: 'vision',
            text,
            ...meta,
            model: target.id,
            note: `由视觉模型 ${target.id} 看图后给出的描述。`,
          });
        }
        console.warn(`[vision] 视觉模型 ${target.id} 返回空内容，改用 OCR`);
      } catch (err) {
        console.warn(`[vision] 视觉模型 ${target.id} 调用失败，改用 OCR：`, (err as Error).message);
      }
    }
  }

  try {
    const ocr = await runOcr(input.bytes, ctx.config);
    const size = meta.width && meta.height ? `${meta.width}×${meta.height}` : '尺寸未知';
    return remember(ctx, key, {
      mode: 'ocr',
      text: ocr.text,
      ...meta,
      confidence: ocr.confidence,
      note:
        `这是 OCR 文字识别结果（${ocr.engine}，${size}${meta.format ? `，${meta.format}` : ''}），不是视觉理解：` +
        '只能读出图里的文字（标题、坐标轴刻度、图例、表格里的数），看不出曲线走势、颜色、形状和空间关系。' +
        (ocr.text ? '' : '没有识别出文字。') +
        (question ? '回答问题时只能依据这些文字，推断不出的部分请如实告诉成员。' : '') +
        '需要真正看图时，请管理员配置 VISION_MODEL。',
    });
  } catch (err) {
    const why =
      err instanceof OcrUnavailableError ? err.message : `OCR 失败：${(err as Error).message}`;
    console.warn('[vision]', why);
    return {
      mode: 'unavailable',
      text: '',
      ...meta,
      note: `读不了这张图：${why}。只知道图片尺寸${meta.width ? ` ${meta.width}×${meta.height}` : '未知'}。请如实告诉成员，并请对方用文字描述图里的内容。`,
    };
  }
}
