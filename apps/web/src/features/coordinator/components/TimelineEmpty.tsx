import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui';
import { tr } from '@/lib/i18n';

export interface TimelineEmptyProps {
  onPick: (text: string) => void;
}

/** 留出对话空间，示例只负责把起点放进输入框。 */
export function TimelineEmpty({ onPick }: TimelineEmptyProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
      <h2 className="text-h2 text-fg">{tr('开始一项研究工作')}</h2>
      <Button
        variant="secondary"
        leftIcon={<ArrowUp size={16} strokeWidth={1.75} aria-hidden />}
        onClick={() => onPick(tr('帮我拆解：下周组会前完成消融实验'))}
      >
        {tr('拆解研究任务')}
      </Button>
    </div>
  );
}
