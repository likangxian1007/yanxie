import { createElement } from 'react';
import type { LucideProps } from 'lucide-react';
import { profileIcon } from '../profile-icon';

export interface ProfileGlyphProps extends LucideProps {
  /** lucide 图标名（profile.icon），不认识的显示 Sparkles */
  icon: string | null | undefined;
}

/** profile 的图标。 */
export function ProfileGlyph({ icon, ...props }: ProfileGlyphProps) {
  return createElement(profileIcon(icon), { strokeWidth: 1.75, 'aria-hidden': true, ...props });
}
