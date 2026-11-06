import { describe, expect, it } from 'vitest';
import { HELP_MODULES, localizeModule, moduleText, TOOL_MODULES } from '@/features/help/content';
import { introForPath, introHow } from './module-intros';
import { localizeStep, TOUR_STEPS } from './tour-steps';

const KEYBOARD = /⌘|Ctrl|按 \?|按 E|键盘|Enter|Tab|Esc|G 然后/u;

describe('触屏文案不讲键盘快捷键', () => {
  it('新手引导每一步在触屏上都不提快捷键', () => {
    for (const steps of Object.values(TOUR_STEPS)) {
      for (const step of steps) {
        const s = localizeStep(step, true);
        expect(`${s.title} ${s.body} ${s.where ?? ''}`).not.toMatch(KEYBOARD);
      }
    }
  });

  it('桌面上保留 ⌘K 的说法', () => {
    const search = TOUR_STEPS.member.find((s) => s.id === 'search');
    expect(search && localizeStep(search, false).title).toContain('⌘K');
    expect(search && localizeStep(search, true).body).toContain('点顶部的放大镜');
  });

  it('待我处理的模块介绍在触屏上不说按 E', () => {
    const intro = introForPath('/p/prj_1/inbox');
    expect(intro).not.toBeNull();
    if (!intro) return;
    expect(introHow(intro, false).join(' ')).toContain('按 E');
    expect(introHow(intro, true).join(' ')).not.toMatch(KEYBOARD);
  });

  it('帮助中心各模块在触屏上不提快捷键（文档编辑器和斜杠指令除外）', () => {
    for (const m of [...HELP_MODULES, ...TOOL_MODULES]) {
      // 文档编辑器的快捷键只在桌面上用；斜杠指令本身就是在输入框里打字
      if (m.id === 'docs' || m.id === 'slash') continue;
      const text = moduleText(localizeModule(m, true));
      expect(text, m.id).not.toMatch(/⌘|按 E|G 然后/u);
    }
  });
});
