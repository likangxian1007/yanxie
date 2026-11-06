/**
 * y-codemirror 的远程选区背景用 awareness.user.colorLight，缺省时拼成 `${color}33`。
 * 我们的颜色是 `var(--palette-n)`，拼出来是无效 CSS，选区就没有底色。
 * 这里给本地 user 补上 colorLight（color-mix 半透明），其他人的编辑器就能画出选区。
 */

export interface AwarenessUser {
  name?: string;
  color?: string;
  colorLight?: string;
  [key: string]: unknown;
}

export function colorLightOf(color: string): string {
  return `color-mix(in oklab, ${color} 22%, transparent)`;
}

/** 需要补 colorLight 时返回补好的 user，否则返回 null */
export function withColorLight(user: unknown): AwarenessUser | null {
  if (!user || typeof user !== 'object') return null;
  const u = user as AwarenessUser;
  if (typeof u.color !== 'string' || !u.color) return null;
  const want = colorLightOf(u.color);
  if (u.colorLight === want) return null;
  return { ...u, colorLight: want };
}

interface AwarenessLike {
  clientID: number;
  getLocalState(): Record<string, unknown> | null;
  setLocalStateField(field: string, value: unknown): void;
  on(event: 'change', cb: (changes: { added: number[]; updated: number[] }) => void): void;
  off(event: 'change', cb: (changes: { added: number[]; updated: number[] }) => void): void;
}

/**
 * 持续保证本地 user 带 colorLight：外层 useCollabDoc 会在 me 变化时整体重写 user，
 * 所以监听 change，本地 user 被覆盖后再补一次（补完后 withColorLight 返回 null，不会循环）。
 */
export function keepColorLight(awareness: AwarenessLike): () => void {
  const apply = () => {
    const next = withColorLight(awareness.getLocalState()?.user);
    if (next) {
      try {
        awareness.setLocalStateField('user', next);
      } catch {
        // 连接已销毁
      }
    }
  };
  const onChange = (changes: { added: number[]; updated: number[] }) => {
    const id = awareness.clientID;
    if (changes.added.includes(id) || changes.updated.includes(id)) apply();
  };
  apply();
  awareness.on('change', onChange);
  return () => awareness.off('change', onChange);
}
