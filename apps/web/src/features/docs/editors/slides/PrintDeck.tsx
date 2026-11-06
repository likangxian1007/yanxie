import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { DeckInfo, SlideModel } from './model/types';
import { SlideRender } from './render/SlideRender';

/**
 * 导出 PDF 用的打印视图：每页幻灯片占一张纸（纸张尺寸 = 页面尺寸，16:9 时 13.33 × 7.5 英寸），
 * 屏幕上不可见；打印时只显示它。浏览器的“另存为 PDF”即得到 PDF。
 * 图片全部加载完后才调用 window.print()。
 */
export function PrintDeck({
  slides,
  deck,
  onDone,
}: {
  slides: SlideModel[];
  deck: DeckInfo;
  onDone: () => void;
}) {
  useEffect(() => {
    let cancelled = false;
    const root = document.querySelector('.sl-print-root');
    const imgs = Array.from(root?.querySelectorAll('img') ?? []);
    const ready = Promise.all(
      imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))),
    );
    const after = () => onDone();
    window.addEventListener('afterprint', after);
    void Promise.race([ready, new Promise((r) => setTimeout(r, 8000))]).then(() => {
      if (cancelled) return;
      document.documentElement.dataset.slidesPrintReady = 'true';
      window.print();
    });
    return () => {
      cancelled = true;
      delete document.documentElement.dataset.slidesPrintReady;
      window.removeEventListener('afterprint', after);
    };
  }, [onDone]);

  const css = `
@page { size: ${deck.width}pt ${deck.height}pt; margin: 0; }
@media screen { .sl-print-root { position: fixed; left: -100000px; top: 0; } }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; height: auto !important; overflow: visible !important; }
  body > *:not(.sl-print-root) { display: none !important; }
  .sl-print-root { display: block !important; position: static !important; }
  .sl-print-page { width: ${deck.width}pt; height: ${deck.height}pt; overflow: hidden; break-after: page; page-break-after: always; }
  .sl-print-page:last-child { break-after: auto; page-break-after: auto; }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}`;
  return createPortal(
    <div className="sl-print-root" aria-hidden>
      <style>{css}</style>
      {slides.map((s) => (
        <div key={s.id} className="sl-print-page">
          <SlideRender elements={s.elements} bg={s.bg} deck={deck} />
        </div>
      ))}
    </div>,
    document.body,
  );
}
