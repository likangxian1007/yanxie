/**
 * 冒烟：把一个带公式、表格、图片、报错的 notebook 导出成全部格式，写到指定目录。
 *   pnpm --filter @srh/server exec tsx scripts/nb-export-smoke.ts <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NOTEBOOK_EXPORT_FORMATS } from '@srh/shared';
import { exportNotebook, findChromium } from '../src/modules/notebooks/export';
import { fromIpynb } from '../src/modules/notebooks/nbformat';

const out = process.argv[2] ?? '.nb-export';
mkdirSync(out, { recursive: true });
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const nb = fromIpynb({
  cells: [
    {
      cell_type: 'markdown',
      source:
        '# 对比学习消融\n\n损失 $\\mathcal{L} = -\\log \\frac{e^{s^+}}{\\sum_j e^{s_j}}$\n\n$$\\tau = 0.07$$',
    },
    {
      cell_type: 'code',
      execution_count: 1,
      source: 'import pandas as pd\ndf = pd.DataFrame({"acc": [0.91, 0.93]})\ndf',
      outputs: [
        {
          output_type: 'execute_result',
          execution_count: 1,
          metadata: {},
          data: {
            'text/plain': '    acc\n0  0.91\n1  0.93',
            'text/html':
              '<table class="dataframe"><thead><tr><th></th><th>acc</th></tr></thead><tbody><tr><th>0</th><td>0.91</td></tr><tr><th>1</th><td>0.93</td></tr></tbody></table>',
          },
        },
      ],
    },
    {
      cell_type: 'code',
      execution_count: 2,
      source: 'plt.plot(x, y)',
      outputs: [
        {
          output_type: 'display_data',
          metadata: {},
          data: { 'image/png': PNG, 'text/plain': '<Figure>' },
        },
      ],
    },
    {
      cell_type: 'code',
      execution_count: 3,
      source: '1/0',
      outputs: [
        {
          output_type: 'error',
          ename: 'ZeroDivisionError',
          evalue: 'division by zero',
          traceback: ['\u001b[0;31mZeroDivisionError\u001b[0m: division by zero'],
        },
      ],
    },
  ],
});
const chromiumPath = findChromium();
console.log('chromium:', chromiumPath);
for (const f of NOTEBOOK_EXPORT_FORMATS) {
  const file = await exportNotebook(nb, '对比学习消融', f, { chromiumPath, author: '张三' });
  writeFileSync(path.join(out, file.filename), file.body);
  console.log(f, file.filename, file.body.length);
}
