import type { DecorationAttrs } from '@tiptap/pm/view';
import { paletteFromString, paletteVar } from '@/lib/palette';
import { tr } from '@/lib/i18n';

/**
 * 协作者光标（CollaborationCaret 的 render / selectionRender）。
 *
 * 注意：CollaborationCaret 会把不是 #rrggbb 的 user.color 换成 transparent 再交给 render，
 * 而我们的 color 是 `var(--palette-n)`，所以这里按 awareness 里的 colorIndex / kind 重新取色。
 */
type AwarenessUser = Record<string, unknown>;

export function isAgentUser(user: AwarenessUser): boolean {
  return user.kind === 'agent';
}

export function peerColor(user: AwarenessUser): string {
  if (isAgentUser(user)) return 'var(--agent)';
  if (typeof user.colorIndex === 'number') return paletteVar(user.colorIndex);
  return paletteVar(paletteFromString(String(user.id ?? user.name ?? '')));
}

export function renderCaret(user: AwarenessUser): HTMLElement {
  const agent = isAgentUser(user);
  const caret = document.createElement('span');
  caret.className = agent ? 'rich-caret rich-caret--agent' : 'rich-caret';
  caret.style.setProperty('--peer-color', peerColor(user));
  caret.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'rich-caret__label';
  label.textContent = String(user.name ?? (agent ? 'AI' : tr('协作者')));
  caret.appendChild(label);
  return caret;
}

export function renderSelection(user: AwarenessUser): DecorationAttrs {
  return {
    nodeName: 'span',
    class: isAgentUser(user)
      ? 'rich-peer-selection rich-peer-selection--agent'
      : 'rich-peer-selection',
    style: `--peer-color: ${peerColor(user)}`,
    'data-user': String(user.name ?? ''),
  };
}
