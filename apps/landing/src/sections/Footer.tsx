import { fmt, useLang } from '../i18n';
import { APP_URL } from '../links';

/** 页脚导航锚点；文案按下标取 t.footer.links */
const NAV = ['#how', '#features', '#hybrid', '#agents', '#mobile', '#selfhost'];

export function Footer() {
  const { t } = useLang();
  const f = t.footer;
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-line/60 px-5 pt-10 pb-8 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <div className="flex flex-col items-center justify-between gap-6 sm:flex-row sm:items-start">
          <a href="#top" className="flex min-h-11 items-center gap-2.5" aria-label={f.topAria}>
            <img src="/favicon.svg" alt="" width={22} height={22} className="size-[22px]" />
            <span className="text-[15px] font-semibold tracking-tight text-fg">{t.brand}</span>
            <span className="hidden text-sm text-faint sm:inline">Scientific Research Harness</span>
          </a>
          <nav aria-label={f.navAria} className="flex flex-wrap justify-center gap-x-1 gap-y-1">
            {NAV.map((href, i) => (
              <a key={href} href={href} className="footer-link">
                {f.links[i]}
              </a>
            ))}
            <a href={APP_URL} className="footer-link text-fg">
              {t.openApp}
            </a>
          </nav>
        </div>
        <div className="flex flex-col items-center justify-between gap-2 border-t border-line/50 pt-6 text-xs text-faint sm:flex-row">
          <span>{fmt(f.copyright, { y: String(year) })}</span>
          <span className="font-mono">co.thinkloft.io</span>
        </div>
      </div>
    </footer>
  );
}
