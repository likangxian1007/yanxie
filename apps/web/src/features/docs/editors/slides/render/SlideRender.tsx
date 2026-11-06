import { memo, type CSSProperties, type ReactNode } from 'react';
import type { Background, DeckInfo, SlideElement } from '../model/types';
import { ElementView, fillCss, pt } from './ElementView';
import './slides.css';

/** 1pt = 4/3 CSS px：页面按 pt 排版，显示宽度 px 时的缩放比 */
export function pageScale(deck: { width: number }, widthPx: number): number {
  return widthPx / ((deck.width * 4) / 3);
}

export function backgroundCss(bg: Background | null, deck: DeckInfo): CSSProperties {
  return { backgroundColor: deck.theme.bg, ...fillCss(bg) };
}

export interface SlideRenderProps {
  elements: SlideElement[];
  bg: Background | null;
  deck: DeckInfo;
  /** 显示宽度（px）；不传时按原尺寸（打印） */
  width?: number;
  className?: string;
  style?: CSSProperties;
  showPrompts?: boolean;
  /** 页面坐标系里的额外层（编辑画布的选框等），同样按 pt 定位 */
  children?: ReactNode;
}

/**
 * 一页幻灯片的静态渲染：缩略图、放映、打印、AI 预览共用；编辑画布用同一个 ElementView。
 */
export const SlideRender = memo(function SlideRender({
  elements,
  bg,
  deck,
  width,
  className,
  style,
  showPrompts,
  children,
}: SlideRenderProps) {
  const scale = width === undefined ? 1 : pageScale(deck, width);
  const page = (
    <div
      className="sl-page"
      style={{
        width: pt(deck.width),
        height: pt(deck.height),
        transform: scale === 1 ? undefined : `scale(${scale})`,
        ...backgroundCss(bg, deck),
      }}
    >
      {elements.map((el) => (
        <ElementView key={el.id} el={el} theme={deck.theme} showPrompt={showPrompts} />
      ))}
      {children}
    </div>
  );
  if (width === undefined) return page;
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width,
        height: (width * deck.height) / deck.width,
        overflow: 'hidden',
        ...style,
      }}
    >
      {page}
    </div>
  );
});
