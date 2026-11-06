import { CircleHelp, Compass, type LucideIcon } from 'lucide-react';
import { projectPath } from '@/components/layout/nav-items';
import { useTourStore } from './tour-store';
import { tr } from '@/lib/i18n';

/** 命令面板里的帮助入口（结构与 CommandPalette 的 Command 一致） */
export interface HelpPaletteCommand {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
  keywords?: string;
  run: () => void;
}

/**
 * “帮助中心”“重看新手引导”两条命令。
 * `go(to)` 是命令面板自己的“关面板 + 跳转”。
 */
export function helpPaletteCommands(
  projectId: string,
  go: (to: string) => () => void,
): HelpPaletteCommand[] {
  return [
    {
      id: 'help-center',
      group: tr('跳转'),
      label: tr('帮助中心'),
      hint: tr('各模块怎么用、快捷键、常见问题'),
      icon: CircleHelp,
      keywords: tr('help faq 帮助 文档 快捷键 shortcut ?'),
      run: go(projectPath(projectId, 'help')),
    },
    {
      id: 'help-tour',
      group: tr('操作'),
      label: tr('重看新手引导'),
      hint: tr('一步步认识各个模块'),
      icon: Compass,
      keywords: tr('tour onboarding guide 引导 新手 教程'),
      run: () => {
        go(projectPath(projectId, ''))();
        useTourStore.getState().requestTour();
      },
    },
  ];
}
