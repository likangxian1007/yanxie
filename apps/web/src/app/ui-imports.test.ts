import { describe, expect, it } from 'vitest';
import uiSource from '@/components/ui/index.ts?raw';
import { directUiImports } from '../../tooling/direct-ui-imports';

const plugin = directUiImports(uiSource);

describe('UI 构建导入优化', () => {
  it('保留值别名和 type 导入，避免按钮引入 Markdown', () => {
    const result = plugin.transform(
      "import { Button as Action, type ButtonProps, Markdown } from '@/components/ui';\nexport const value = Action;",
      '/project/apps/web/src/example.tsx',
    );
    expect(result?.code).toContain(
      "import { Button as Action, type ButtonProps } from '@/components/ui/Button';",
    );
    expect(result?.code).toContain("import { Markdown } from '@/components/ui/Markdown';");
    expect(result?.code).toContain('export const value = Action;');
    expect(result?.code).not.toMatch(/from ['"]@\/components\/ui['"]/u);
  });

  it('未知导出与非源码文件保持原样，避免丢失无法识别的导入', () => {
    expect(
      plugin.transform("import { Unknown, Button } from '@/components/ui';", '/src/example.tsx'),
    ).toBeUndefined();
    expect(
      plugin.transform("import { Button } from '@/components/ui';", '/fixtures/example.txt'),
    ).toBeUndefined();
  });
});
