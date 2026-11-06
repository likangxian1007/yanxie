import {
  Bot,
  Brain,
  BookOpen,
  BookOpenText,
  Calculator,
  ChartColumn,
  Code,
  Database,
  FlaskConical,
  GraduationCap,
  Library,
  Lightbulb,
  ListChecks,
  Microscope,
  NotebookPen,
  PenLine,
  Presentation,
  Search,
  Sparkles,
  Target,
  type LucideIcon,
} from 'lucide-react';

/**
 * profile 的 icon 字段是 lucide 图标名。为了不把整个图标库打进包里，只认这一组常用的，
 * 其余一律显示 Sparkles。
 */
export const PROFILE_ICONS: Record<string, LucideIcon> = {
  Sparkles,
  Bot,
  Brain,
  BookOpen,
  BookOpenText,
  Calculator,
  ChartColumn,
  Code,
  Database,
  FlaskConical,
  GraduationCap,
  Library,
  Lightbulb,
  ListChecks,
  Microscope,
  NotebookPen,
  PenLine,
  Presentation,
  Search,
  Target,
};

export const PROFILE_ICON_NAMES = Object.keys(PROFILE_ICONS);

export function profileIcon(name: string | null | undefined): LucideIcon {
  return (name && PROFILE_ICONS[name]) || Sparkles;
}
