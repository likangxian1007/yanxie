import { useMemo } from 'react';
import * as Y from 'yjs';
import { useElementSize } from '../../shared/dom';
import type { SlideDraft } from '../lib/markdown';
import { draftToSlide } from '../model';
import { createSlideMap, readSlide, readSlideRefs, getSlidesArray } from '../model/deck';
import { DEFAULT_SIZE, DEFAULT_THEME } from '../model/themes';
import type { DeckInfo, SlideModel } from '../model/types';
import { SlideRender } from './SlideRender';

const PREVIEW_DECK: DeckInfo = { ...DEFAULT_SIZE, theme: DEFAULT_THEME };

/** AI 草稿 → 渲染用的页（临时 Y.Doc，与真正插入时生成的元素完全一致） */
export function draftModel(d: SlideDraft, deck: DeckInfo = PREVIEW_DECK): SlideModel {
  const doc = new Y.Doc();
  const map = createSlideMap(draftToSlide(d, deck), deck, 'a0');
  getSlidesArray(doc).push([map]);
  return readSlide(readSlideRefs(getSlidesArray(doc))[0]!, deck);
}

/** 宽度自适应的一页静态预览 */
export function SlidePreview({
  slide,
  deck = PREVIEW_DECK,
  className,
}: {
  slide: SlideModel;
  deck?: DeckInfo;
  className?: string;
}) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={className}
      style={{ aspectRatio: `${deck.width} / ${deck.height}`, overflow: 'hidden' }}
    >
      {size.width > 0 && (
        <SlideRender elements={slide.elements} bg={slide.bg} deck={deck} width={size.width} />
      )}
    </div>
  );
}

export function DraftPreview({ draft, className }: { draft: SlideDraft; className?: string }) {
  const model = useMemo(() => draftModel(draft), [draft]);
  return <SlidePreview slide={model} className={className} />;
}
