import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { bootI18n } from './lib/i18n';

// 先装好界面语言的词典，再加载应用代码（应用模块顶层的文案也要按所选语言取）
async function start(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing #root mount point');
  await bootI18n().catch((err: unknown) => console.error('[i18n] failed to load dictionary', err));
  // 报错上报会引入 @srh/shared，必须在词典装好之后再加载
  const [{ initClientErrors }, { App }] = await Promise.all([
    import('./lib/client-errors'),
    import('./app/App'),
  ]);
  initClientErrors();
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
