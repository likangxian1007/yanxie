import type { FieldSync } from './field-sync';
import { ConflictPanel, RemoteChangedHint } from './ConflictPanel';

export interface SyncNoticeProps<T extends { version: number }, K extends keyof T & string> {
  sync: FieldSync<T>;
  field: K;
  /** 字段名（中文），如「假设」 */
  label: string;
  /** 把字段值显示成文字（默认 String） */
  format?: (value: T[K]) => string;
  /** 文本字段：允许手动合并（结果按字符串写回） */
  manual?: boolean;
  className?: string;
}

/**
 * 一个字段的协作提示：编辑中对方改了 → 小提示；保存撞上冲突 → 合并视图。
 * 都没有时不渲染。父组件需要用 useFieldSync 订阅同一个 sync。
 */
export function SyncNotice<T extends { version: number }, K extends keyof T & string>({
  sync,
  field,
  label,
  format = (v) => (v === null || v === undefined ? '' : String(v)),
  manual = false,
  className,
}: SyncNoticeProps<T, K>) {
  const f = sync.field(field);
  if (f.conflict) {
    const { mine, theirs, base } = f.conflict;
    return (
      <ConflictPanel
        className={className}
        label={label}
        mine={format(mine)}
        theirs={format(theirs)}
        base={format(base)}
        who={sync.remoteActor}
        allowManual={manual}
        onKeepMine={() => sync.keepMine(field)}
        onTakeTheirs={() => sync.takeTheirs(field)}
        onMerge={manual ? (text) => sync.resolveWith(field, text as T[K]) : undefined}
      />
    );
  }
  if (f.remoteChanged) {
    return (
      <RemoteChangedHint
        className={className}
        who={sync.remoteActor}
        theirs={format(f.serverValue)}
      />
    );
  }
  return null;
}
