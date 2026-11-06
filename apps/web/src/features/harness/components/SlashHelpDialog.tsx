import { Button, Dialog } from '@/components/ui';
import { SLASH_GROUP_LABEL, type SlashGroup, type SlashItem } from '../slash';
import { tr, trServer } from '@/lib/i18n';

export interface SlashHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: SlashItem[];
}

const GROUPS: SlashGroup[] = ['builtin', 'skill', 'custom'];

/** /help：列出这里能用的全部斜杠指令。 */
export function SlashHelpDialog({ open, onOpenChange, items }: SlashHelpDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={tr('斜杠指令')}
      description={tr(
        '在输入框开头输入 / 可以弹出指令菜单。没有对应指令的 /文字 会当普通消息发出。',
      )}
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          {tr('知道了')}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {GROUPS.map((g) => {
          const list = items.filter((i) => i.group === g);
          if (list.length === 0) return null;
          return (
            <section key={g} aria-label={SLASH_GROUP_LABEL[g]}>
              <h3 className="mb-1.5 text-caption text-fg-subtle">{SLASH_GROUP_LABEL[g]}</h3>
              <dl className="flex flex-col divide-y divide-line rounded-lg border border-line">
                {list.map((i) => (
                  <div
                    key={i.name}
                    className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3"
                  >
                    <dt className="shrink-0 font-mono text-small text-fg sm:w-48">
                      /{i.name}
                      {i.argumentHint && (
                        <span className="ml-1.5 text-caption font-normal text-fg-subtle">
                          {trServer(i.argumentHint)}
                        </span>
                      )}
                    </dt>
                    <dd className="min-w-0 text-small text-fg-muted">
                      {i.label && <span className="mr-1.5 text-fg">{i.label}</span>}
                      {trServer(i.description)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
