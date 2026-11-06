import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parseSlidesMarkdown } from '../lib/markdown';
import {
  createSlideMap,
  deleteSlide,
  duplicateSlide,
  getDeckMeta,
  getSlidesArray,
  insertSlides,
  moveSlide,
  normalizeDeck,
  readAllSlides,
  readDeckInfo,
  readSlide,
  readSlideRefs,
  replaceAllWithDrafts,
  slideToDraft,
} from '.';
import {
  addElements,
  alignRects,
  distributeRects,
  expandGroups,
  formatFragment,
  parseClipboard,
  serializeElements,
  cloneInits,
  toggleListPm,
  zOrderPatches,
} from './elements';
import { applyLayout } from './insert';
import { cmpKey, keysAt } from './order';
import {
  fragmentFromPm,
  markdownToPm,
  pmPlainText,
  pmToMarkdown,
  readPm,
  writePm,
  type PmNode,
} from './richtext';
import { DEFAULT_THEME, THEMES } from './themes';
import type { DeckInfo, SlideElement, TextElement } from './types';

const DECK: DeckInfo = { width: 960, height: 540, theme: DEFAULT_THEME };

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function titles(doc: Y.Doc) {
  return readAllSlides(doc, readDeckInfo(getDeckMeta(doc))).map((s) => s.title);
}

/** 旧版（v1）页：id/layout/title/body/notes 都是 Y.Text，没有 order */
function legacySlide(id: string, title: string, body = '', layout = 'content') {
  const m = new Y.Map<unknown>();
  m.set('id', id);
  m.set('layout', layout);
  m.set('title', new Y.Text(title));
  m.set('body', new Y.Text(body));
  m.set('notes', new Y.Text(`备注 ${title}`));
  return m;
}

describe('rich text ⇄ Y.XmlFragment', () => {
  const doc: PmNode = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { textAlign: 'center', lineHeight: 1.5 },
        content: [
          { type: 'text', text: '粗体', marks: [{ type: 'bold' }] },
          {
            type: 'text',
            text: '红字',
            marks: [{ type: 'textStyle', attrs: { color: '#FF0000', fontSize: '24pt' } }],
          },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '要点一' }] }],
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '要点二' }] }],
          },
        ],
      },
    ],
  };

  it('round-trips nodes, marks and paragraph attrs', () => {
    const y = new Y.Doc();
    const frag = y.getXmlFragment('t');
    writePm(frag, doc);
    const back = readPm(frag);
    expect(back.content?.[0]?.attrs).toMatchObject({ textAlign: 'center', lineHeight: 1.5 });
    expect(back.content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }]);
    expect(back.content?.[0]?.content?.[1]?.marks?.[0]).toMatchObject({
      type: 'textStyle',
      attrs: { color: '#FF0000', fontSize: '24pt' },
    });
    expect(back.content?.[1]?.type).toBe('bulletList');
    expect(pmPlainText(back)).toBe('粗体红字\n要点一\n要点二');
  });

  it('converts markdown bodies to lists and back', () => {
    const pm = markdownToPm('- 复现 **ViT**\n- 消融\n  - 16 优于 32');
    expect(pm.content?.[0]?.type).toBe('bulletList');
    expect(pmToMarkdown(pm)).toContain('- 复现 **ViT**');
    expect(pmToMarkdown(pm)).toContain('  - 16 优于 32');
  });

  it('formats a whole fragment without losing concurrent text', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const fa = a.getMap('m');
    fa.set('f', fragmentFromPm(markdownToPm('你好世界')));
    sync(a, b);
    const fragA = a.getMap('m').get('f') as Y.XmlFragment;
    const fragB = b.getMap('m').get('f') as Y.XmlFragment;
    a.transact(() => formatFragment(fragA, 'bold', {}));
    // 另一人同时在末尾打字
    const textB = (fragB.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    textB.insert(textB.length, '！');
    sync(a, b);
    expect(pmPlainText(readPm(fragA))).toBe('你好世界！');
    expect(readPm(fragB).content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }]);
  });

  it('toggles bullet lists for a whole box', () => {
    const pm = markdownToPm('一\n\n二');
    const list = toggleListPm(pm, 'bulletList');
    expect(list.content?.[0]?.type).toBe('bulletList');
    expect(list.content?.[0]?.content).toHaveLength(2);
    expect(toggleListPm(list, 'bulletList').content?.map((n) => n.type)).toEqual([
      'paragraph',
      'paragraph',
    ]);
  });
});

describe('fractional order keys', () => {
  it('generates keys between neighbours', () => {
    const ks = keysAt(['a0', 'a1'], 1, 3);
    expect(ks).toHaveLength(3);
    const all = ['a0', ...ks, 'a1'];
    expect([...all].sort(cmpKey)).toEqual(all);
  });
});

describe('deck model', () => {
  it('creates layout placeholders with deterministic ids and reads titles', () => {
    const doc = new Y.Doc();
    const ids = insertSlides(
      doc,
      0,
      [{ layout: 'title', content: { title: '组会汇报', subtitle: '张三' } }],
      null,
    );
    const s = readAllSlides(doc, DECK)[0]!;
    expect(s.version).toBe(2);
    expect(s.title).toBe('组会汇报');
    expect(s.elements.map((e) => e.id)).toContain(`${ids[0]}-title`);
    const title = s.elements.find((e) => e.ph === 'title') as TextElement;
    expect(title.frag).toBeInstanceOf(Y.XmlFragment);
    // 主题令牌按当前主题解析
    expect(title.style.color).toBe(DEFAULT_THEME.fg);
    const dark = THEMES.find((t) => t.id === 'dark')!;
    const again = readSlide(readSlideRefs(getSlidesArray(doc))[0]!, { ...DECK, theme: dark });
    expect((again.elements.find((e) => e.ph === 'title') as TextElement).style.color).toBe(dark.fg);
  });

  it('reads legacy v1 slides on the fly and migrates them lazily', () => {
    const doc = new Y.Doc();
    getSlidesArray(doc).push([
      legacySlide('a', '封面', '张三', 'title'),
      legacySlide('b', '本周进展', '- 复现\n- 消融'),
      legacySlide('c', '对比', '左边\n\n---\n\n右边', 'two-column'),
    ]);
    const before = readAllSlides(doc, DECK);
    expect(before.map((s) => s.version)).toEqual([1, 1, 1]);
    expect(before.map((s) => s.title)).toEqual(['封面', '本周进展', '对比']);
    expect(normalizeDeck(doc)).toBe(true);
    const after = readAllSlides(doc, DECK);
    expect(after.map((s) => s.version)).toEqual([2, 2, 2]);
    expect(after.map((s) => s.title)).toEqual(['封面', '本周进展', '对比']);
    expect(after.map((s) => s.notes)).toEqual(['备注 封面', '备注 本周进展', '备注 对比']);
    const body = after[1]!.elements.find((e) => e.ph === 'body') as TextElement;
    expect(body.doc.content?.[0]?.type).toBe('bulletList');
    // 两栏：两个正文框
    expect(after[2]!.elements.filter((e) => e.ph === 'body')).toHaveLength(2);
    // 已经迁移过：再调用不改
    expect(normalizeDeck(doc)).toBe(false);
  });

  it('converges when two clients migrate the same legacy deck concurrently', () => {
    const a = new Y.Doc();
    getSlidesArray(a).push([legacySlide('a', '一'), legacySlide('b', '二')]);
    const b = new Y.Doc();
    sync(a, b);
    normalizeDeck(a);
    normalizeDeck(b);
    sync(a, b);
    const sa = readAllSlides(a, DECK);
    const sb = readAllSlides(b, DECK);
    expect(sa.map((s) => s.title)).toEqual(['一', '二']);
    expect(sb.map((s) => s.title)).toEqual(['一', '二']);
    expect(sa[0]!.elements.map((e) => e.id).sort()).toEqual(
      sb[0]!.elements.map((e) => e.id).sort(),
    );
    expect(sa[0]!.elements.filter((e) => e.ph === 'title')).toHaveLength(1);
  });

  it('moves only the order key (the page map keeps its identity)', () => {
    const doc = new Y.Doc();
    insertSlides(
      doc,
      0,
      ['A', 'B', 'C'].map((t) => ({ layout: 'title-only' as const, content: { title: t } })),
      null,
    );
    const before = readSlideRefs(getSlidesArray(doc));
    moveSlide(doc, 0, 2, null);
    expect(titles(doc)).toEqual(['B', 'C', 'A']);
    const after = readSlideRefs(getSlidesArray(doc));
    expect(after[2]!.map).toBe(before[0]!.map);
    // 数组本身没动
    expect(getSlidesArray(doc).get(0)).toBe(before[0]!.map);
  });

  it('keeps concurrent edits when a slide is moved (two Y.Docs)', () => {
    const a = new Y.Doc();
    insertSlides(
      a,
      0,
      ['A', 'B', 'C', 'D'].map((t) => ({ layout: 'title-only' as const, content: { title: t } })),
      null,
    );
    const b = new Y.Doc();
    sync(a, b);
    // A 把第 1 页拖到最后；B 同时在第 1 页标题里打字、并在第 3 页后面插一页
    moveSlide(a, 0, 3, null);
    const refB = readSlideRefs(getSlidesArray(b))[0]!;
    const titleB = readSlide(refB, DECK).elements.find((e) => e.ph === 'title') as TextElement;
    const t = (titleB.frag!.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    t.insert(1, '（已改）');
    insertSlides(b, 3, [{ layout: 'title-only', content: { title: 'X' } }], null);
    sync(a, b);
    expect(titles(a)).toEqual(['B', 'C', 'X', 'D', 'A（已改）']);
    expect(titles(b)).toEqual(titles(a));
  });

  it('two users moving different slides concurrently both take effect', () => {
    const a = new Y.Doc();
    insertSlides(
      a,
      0,
      ['A', 'B', 'C', 'D', 'E'].map((t) => ({
        layout: 'title-only' as const,
        content: { title: t },
      })),
      null,
    );
    const b = new Y.Doc();
    sync(a, b);
    moveSlide(a, 0, 4, null); // A 到最后
    moveSlide(b, 4, 1, null); // E 到 A、B 之间
    sync(a, b);
    // A 已经移走：E 落在 B 前面
    expect(titles(a)).toEqual(['E', 'B', 'C', 'D', 'A']);
    expect(titles(b)).toEqual(titles(a));
  });

  it('duplicates and deletes slides', () => {
    const doc = new Y.Doc();
    insertSlides(
      doc,
      0,
      ['A', 'B'].map((t) => ({ layout: 'title-only' as const, content: { title: t } })),
      null,
    );
    const refs = readSlideRefs(getSlidesArray(doc));
    const id = duplicateSlide(doc, refs[0]!, null);
    expect(titles(doc)).toEqual(['A', 'A', 'B']);
    expect(readSlideRefs(getSlidesArray(doc))[1]!.id).toBe(id);
    deleteSlide(doc, refs[1]!.map, null);
    expect(titles(doc)).toEqual(['A', 'A']);
  });

  it('replaces the deck from AI drafts and exports drafts back', () => {
    const doc = new Y.Doc();
    replaceAllWithDrafts(doc, parseSlidesMarkdown('## 封面\n张三\n\n## 进展\n- 一\n- 二'), null);
    const slides = readAllSlides(doc, DECK);
    expect(slides.map((s) => s.title)).toEqual(['封面', '进展']);
    const d = slideToDraft(slides[1]!);
    expect(d.title).toBe('进展');
    expect(d.body).toContain('- 一');
  });

  it('changes layout by moving placeholders and keeping content', () => {
    const doc = new Y.Doc();
    insertSlides(doc, 0, [{ layout: 'content', content: { title: '标题', body: '- 正文' } }], null);
    const s = readAllSlides(doc, DECK)[0]!;
    applyLayout(doc, s, 'two-column', DECK, null);
    const after = readAllSlides(doc, DECK)[0]!;
    expect(after.layout).toBe('two-column');
    expect(after.title).toBe('标题');
    expect(after.elements.filter((e) => e.ph === 'body')).toHaveLength(2);
    const bodies = after.elements.filter((e) => e.ph === 'body') as TextElement[];
    expect(bodies.map((b) => pmPlainText(b.doc)).sort()).toEqual(['', '正文']);
  });

  it('writes element geometry and reads it back with defaults', () => {
    const doc = new Y.Doc();
    const map = createSlideMap(
      {
        elements: [
          {
            type: 'shape',
            shape: 'ellipse',
            x: 10,
            y: 20,
            w: 100,
            h: 50,
            rot: 30,
            fill: { type: 'color', color: '#FF8800' },
          },
          { type: 'line', x: 0, y: 0, w: 100, h: 0, end: 'triangle' },
          {
            type: 'table',
            x: 0,
            y: 100,
            w: 300,
            h: 60,
            cells: [
              [{ text: '甲' }, { text: '乙' }],
              [{ text: '1' }, { text: '2' }],
            ],
          },
          {
            type: 'image',
            x: 500,
            y: 100,
            w: 200,
            h: 100,
            src: '/img.png',
            crop: { l: 0.1, t: 0, r: 0, b: 0 },
          },
        ],
      },
      DECK,
      'a0',
    );
    getSlidesArray(doc).push([map]);
    const s = readAllSlides(doc, DECK)[0]!;
    expect(s.elements.map((e) => e.type)).toEqual(['shape', 'line', 'table', 'image']);
    expect(s.elements[0]).toMatchObject({ x: 10, y: 20, w: 100, h: 50, rot: 30, shape: 'ellipse' });
    expect(s.elements[1]).toMatchObject({ end: 'triangle', start: 'none' });
    const table = s.elements[2]!;
    expect(table.type === 'table' && table.cells[1]![1]!.text).toBe('2');
    expect(table.type === 'table' && table.colW).toEqual([150, 150]);
    expect(s.elements[3]).toMatchObject({ src: '/img.png', crop: { l: 0.1 } });
  });
});

describe('element operations', () => {
  function setup() {
    const doc = new Y.Doc();
    insertSlides(doc, 0, [{ layout: 'blank' }], null);
    const read = () => readAllSlides(doc, DECK)[0]!;
    const ids = addElements(
      doc,
      read().map,
      read().elements,
      [
        { type: 'shape', x: 0, y: 0, w: 100, h: 100 },
        { type: 'shape', x: 200, y: 50, w: 100, h: 100 },
        { type: 'shape', x: 500, y: 10, w: 50, h: 50 },
      ],
      null,
    );
    return { doc, read, ids };
  }

  it('reorders z (front/back/forward/backward)', () => {
    const { read, ids } = setup();
    const els = read().elements;
    const apply = (patch: Map<string, string>, list: SlideElement[]) =>
      list
        .map((e) => ({ ...e, z: patch.get(e.id) ?? e.z }))
        .sort((a, b) => cmpKey(a.z, b.z))
        .map((e) => e.id);
    expect(apply(zOrderPatches(els, [ids[0]!], 'front'), els)).toEqual([ids[1], ids[2], ids[0]]);
    expect(apply(zOrderPatches(els, [ids[2]!], 'back'), els)).toEqual([ids[2], ids[0], ids[1]]);
    expect(apply(zOrderPatches(els, [ids[0]!], 'forward'), els)).toEqual([ids[1], ids[0], ids[2]]);
    expect(apply(zOrderPatches(els, [ids[2]!], 'backward'), els)).toEqual([ids[0], ids[2], ids[1]]);
  });

  it('aligns and distributes', () => {
    const { read } = setup();
    const els = read().elements;
    const left = alignRects(els, 'left', DECK);
    expect([...left.values()].map((p) => p.x)).toEqual([0, 0, 0]);
    const one = alignRects([els[0]!], 'hcenter', DECK);
    expect(one.get(els[0]!.id)?.x).toBe(430);
    const dist = distributeRects(els, 'h');
    // 总宽 550，元素宽 250，间距 150
    expect(dist.get(els[1]!.id)?.x).toBe(250);
  });

  it('expands groups and clones via clipboard', () => {
    const { read } = setup();
    const els = read().elements.map((e, i) => ({
      ...e,
      group: i < 2 ? 'g1' : null,
    })) as SlideElement[];
    expect(expandGroups(els, [els[0]!.id]).sort()).toEqual([els[0]!.id, els[1]!.id].sort());
    const parsed = parseClipboard(serializeElements(els.slice(0, 2)))!;
    expect(parsed).toHaveLength(2);
    const clones = cloneInits(parsed, 10);
    expect(clones[0]!.x).toBe(10);
    expect(clones[0]!.group).toBe(clones[1]!.group);
    expect(clones[0]!.group).not.toBe('g1');
    expect(clones[0]!.id).not.toBe(els[0]!.id);
  });
});
