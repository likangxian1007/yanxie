// UI 的 re-export barrel 会让自动分块把 Markdown、菜单等归为所有页面的共同依赖。
// 构建时展开为等价的具名直接导入，保留页面源码的统一导入接口。
export function directUiImports(source: string) {
  const exports = new Map<string, string>();
  for (const match of source.matchAll(/export\s*\{([^}]+)\}\s*from\s*'\.\/([^']+)'/gu)) {
    for (const item of match[1]!.split(',')) {
      const name = item
        .trim()
        .replace(/^type\s+/u, '')
        .split(/\s+as\s+/u)
        .at(-1);
      if (name) exports.set(name, match[2]!);
    }
  }
  return {
    name: 'srh-direct-ui-imports',
    enforce: 'pre' as const,
    apply: 'build' as const,
    transform(code: string, id: string) {
      if (!/[\\/]src[\\/].*\.[jt]sx?$/u.test(id) || !code.includes('@/components/ui')) return;
      const rewritten = code.replace(
        /import\s*\{([^}]+)\}\s*from\s*['"]@\/components\/ui['"];?/gu,
        (original, names: string) => {
          const imports = new Map<string, string[]>();
          for (const item of names
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)) {
            const name = item.replace(/^type\s+/u, '').split(/\s+as\s+/u)[0]!;
            const module = exports.get(name);
            if (!module) return original;
            imports.set(module, [...(imports.get(module) ?? []), item]);
          }
          return [...imports]
            .map(
              ([module, items]) =>
                `import { ${items.join(', ')} } from '@/components/ui/${module}';`,
            )
            .join('\n');
        },
      );
      if (rewritten !== code) return { code: rewritten, map: null };
    },
  };
}
