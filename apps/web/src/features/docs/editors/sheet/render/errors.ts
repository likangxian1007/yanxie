import { tr } from '@/lib/i18n';
/** 错误值的悬停说明 */
export function errorHint(code: string): string {
  switch (code) {
    case '#CYCLE!':
      return tr('#CYCLE!：循环引用，公式直接或间接引用了自己');
    case '#REF!':
      return tr('#REF!：引用的单元格或工作表已被删除');
    case '#DIV/0!':
      return tr('#DIV/0!：除数为 0');
    case '#NAME?':
      return tr('#NAME?：不认识的函数或名称');
    case '#VALUE!':
      return tr('#VALUE!：参数类型不对（例如文本参与了计算）');
    case '#NUM!':
      return tr('#NUM!：数值无效');
    case '#N/A':
      return tr('#N/A：查找不到匹配的值');
    default:
      return tr('{code}：公式有语法错误', { code });
  }
}
