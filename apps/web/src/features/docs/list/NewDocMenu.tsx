import type { DocumentKind } from '@srh/shared';
import { ChevronDown, LayoutTemplate, Plus } from 'lucide-react';
import { Button, Menu, MenuItem, MenuSeparator } from '@/components/ui';
import { DOC_KIND_META, DOC_KINDS, DocKindIcon } from '../kinds';
import { tr } from '@/lib/i18n';

/** 页头“新建”主按钮：四类空白文档 + 从模板新建 */
export function NewDocMenu({
  onCreate,
  onTemplates,
  loading,
  disabled,
}: {
  onCreate: (kind: DocumentKind) => void;
  onTemplates: () => void;
  loading: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu
      align="end"
      label={tr('新建')}
      className="w-64"
      trigger={
        <Button
          variant="primary"
          loading={loading}
          disabled={disabled}
          leftIcon={<Plus strokeWidth={2} aria-hidden />}
          rightIcon={<ChevronDown strokeWidth={1.75} aria-hidden className="-mr-1" />}
        >
          {tr('新建')}
        </Button>
      }
    >
      {DOC_KINDS.map((kind) => (
        <MenuItem
          key={kind}
          icon={<DocKindIcon kind={kind} size="sm" />}
          description={DOC_KIND_META[kind].description}
          onSelect={() => onCreate(kind)}
        >
          {DOC_KIND_META[kind].label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={<LayoutTemplate strokeWidth={1.75} aria-hidden />} onSelect={onTemplates}>
        {tr('从模板新建…')}
      </MenuItem>
    </Menu>
  );
}
