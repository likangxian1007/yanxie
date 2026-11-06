import {
  LANG_STORAGE_KEY,
  getLang,
  locale,
  registerDict,
  registerServerDict,
  setLang,
  tr,
  trServer,
  type UiLang,
} from '@srh/shared/i18n';

/**
 * 界面语言：中文为默认，用户切换后记在本机（localStorage），切换时刷新页面。
 * 用法见 packages/shared/src/i18n.ts：中文原文就是 key，`tr('重试')`。
 */
export { getLang, locale, tr, trServer };
export type { UiLang };

/** 在加载其余代码之前调用：英文界面先装好词典，模块顶层的 tr() 才能拿到英文。 */
export async function bootI18n(): Promise<void> {
  const lang = getLang();
  setLang(lang);
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  if (lang !== 'en') return;
  const [web, shared, server] = await Promise.all([
    import('../i18n/en/web.json'),
    import('../i18n/en/shared.json'),
    import('../i18n/en/server.json'),
  ]);
  registerDict(web.default);
  registerDict(shared.default);
  registerServerDict(server.default);
  registerServerDict(shared.default);
  document.title = 'Thinkloft';
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute('content', 'Thinkloft: a multi-agent AI workspace for research teams');
}

/** 切换界面语言：记住选择后刷新，让所有页面（含已加载的模块）都换成新语言 */
export function switchLang(lang: UiLang): void {
  if (lang === getLang()) return;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // 存不了就只在本次生效
  }
  setLang(lang);
  window.location.reload();
}
