import { useState } from 'react';
import { History } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { canWrite, useMyRole } from '@/lib/project';
import { VersionHistorySheet } from './VersionHistorySheet';
import { tr } from '@/lib/i18n';

/** 项目文件的版本历史入口（文件每次被覆盖都会自动存一版） */
export function FileHistoryButton({
  pid,
  fileId,
  title,
  className,
}: {
  pid: string;
  fileId: string;
  title: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const role = useMyRole(pid);
  return (
    <>
      <IconButton
        label={tr('文件版本历史')}
        size="sm"
        variant="ghost"
        className={className}
        onClick={() => setOpen(true)}
      >
        <History size={16} strokeWidth={1.75} />
      </IconButton>
      <VersionHistorySheet
        open={open}
        onOpenChange={setOpen}
        pid={pid}
        targetKind="file"
        targetId={fileId}
        title={title}
        editable={canWrite(role)}
      />
    </>
  );
}
