import type * as Y from 'yjs';
import { shortId } from '../../shared/dom';
import { createElementMap, type ElementInit } from './deck';
import { ensureElementsMap } from './elements';
import { cmpKey, keysAt } from './order';
import { pmIsEmpty, plainToPm } from './richtext';
import { layoutElements } from './themes';
import type { DeckInfo, LayoutId, SlideModel } from './types';
import { tr } from '@/lib/i18n';

/** 新建元素的默认样子（放在页面中间） */
export function defaultInit(
  kind: 'text' | 'shape' | 'line' | 'arrow' | 'table' | 'image',
  deck: DeckInfo,
  opts: {
    shape?: string;
    rows?: number;
    cols?: number;
    src?: string;
    fileId?: string;
    ratio?: number;
  } = {},
): ElementInit {
  const cx = deck.width / 2;
  const cy = deck.height / 2;
  switch (kind) {
    case 'text':
      return {
        type: 'text',
        x: cx - 160,
        y: cy - 24,
        w: 320,
        h: 48,
        style: { fontSize: 24 },
        autofit: 'grow',
        doc: plainToPm(''),
        name: tr('文本框'),
      };
    case 'shape':
      return {
        type: 'shape',
        shape: opts.shape ?? 'rect',
        x: cx - 90,
        y: cy - 60,
        w: 180,
        h: 120,
        fill: { type: 'color', color: 'theme:accent' },
        stroke: null,
        valign: 'middle',
        style: { fontSize: 18, color: '#FFFFFF', align: 'center' },
        name: tr('形状'),
      };
    case 'line':
    case 'arrow':
      return {
        type: 'line',
        x: cx - 120,
        y: cy,
        w: 240,
        h: 0,
        stroke: { color: 'theme:fg', width: 2, dash: 'solid' },
        start: 'none',
        end: kind === 'arrow' ? 'triangle' : 'none',
        name: kind === 'arrow' ? tr('箭头') : tr('直线'),
      };
    case 'table': {
      const rows = opts.rows ?? 3;
      const cols = opts.cols ?? 3;
      const w = Math.min(deck.width * 0.8, cols * 140);
      const rowH = 32;
      return {
        type: 'table',
        x: cx - w / 2,
        y: cy - (rows * rowH) / 2,
        w,
        h: rows * rowH,
        colW: Array.from({ length: cols }, () => w / cols),
        rowH: Array.from({ length: rows }, () => rowH),
        cells: Array.from({ length: rows }, () =>
          Array.from({ length: cols }, () => ({ text: '' })),
        ),
        header: true,
        name: tr('表格'),
      };
    }
    case 'image': {
      const ratio = opts.ratio && opts.ratio > 0 ? opts.ratio : 4 / 3;
      let w = deck.width * 0.5;
      let h = w / ratio;
      if (h > deck.height * 0.7) {
        h = deck.height * 0.7;
        w = h * ratio;
      }
      return {
        type: 'image',
        x: cx - w / 2,
        y: cy - h / 2,
        w,
        h,
        src: opts.src ?? '',
        fileId: opts.fileId ?? null,
        fit: 'fill',
        name: tr('图片'),
      };
    }
  }
}

/**
 * 换版式：按角色（标题 / 副标题 / 第 n 个正文）把现有占位符挪到新位置，缺的补上；
 * 新版式里没有的空占位符删掉，有内容的保留。
 */
export function applyLayout(
  doc: Y.Doc,
  slide: SlideModel,
  layout: LayoutId,
  deck: DeckInfo,
  origin: unknown,
): void {
  const inits = layoutElements(layout, deck, `${slide.id}-${layout}-`);
  const existing = slide.elements.filter((e) => e.ph);
  const used = new Set<string>();
  const counters: Record<string, number> = {};
  doc.transact(() => {
    const els = ensureElementsMap(slide.map);
    const fresh: ElementInit[] = [];
    for (const init of inits) {
      if (!init.ph) {
        fresh.push(init as ElementInit);
        continue;
      }
      const n = (counters[init.ph] = (counters[init.ph] ?? 0) + 1);
      const match = existing.filter((e) => e.ph === init.ph)[n - 1];
      if (match?.map) {
        used.add(match.id);
        match.map.set('x', init.x);
        match.map.set('y', init.y);
        match.map.set('w', init.w);
        match.map.set('h', init.h);
        if (init.valign) match.map.set('valign', init.valign);
      } else fresh.push(init as ElementInit);
    }
    for (const e of existing) {
      if (used.has(e.id)) continue;
      const empty = (e.type === 'text' || e.type === 'shape') && pmIsEmpty(e.doc);
      if (empty) els.delete(e.id);
    }
    // 版式的装饰元素（章节页的色条）换版式时去掉
    for (const e of slide.elements) if (!e.ph && /-bar$/u.test(e.id)) els.delete(e.id);
    // 新补的占位符放在最底层（不挡住用户自己加的元素）
    const zs = keysAt(slide.elements.map((e) => e.z).sort(cmpKey), 0, fresh.length);
    fresh.forEach((init, i) => {
      const eid = init.id && !els.has(init.id) ? init.id : shortId('e');
      els.set(eid, createElementMap({ ...init, id: eid, z: zs[i] }));
    });
    slide.map.set('layout', layout);
  }, origin);
}
