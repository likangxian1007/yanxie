import * as Y from 'yjs';
import type { NbOutput } from '@srh/shared';
import { cellsOf } from '../nbformat';

/** 单个流式输出的上限（超出截断，保留尾部，和 Jupyter 的「输出过长」类似） */
export const MAX_STREAM_CHARS = 1_000_000;

/**
 * 终端回车语义：同一行里 \r 之前的内容被后面的覆盖（tqdm 进度条），\r\n 当换行。
 * 行尾单独的 \r 保留，等下一段输出来覆盖。
 */
export function fixConsole(text: string): string {
  return text
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((line) => {
      const trimmed = line.replace(/\r+$/, '');
      const i = trimmed.lastIndexOf('\r');
      const kept = i >= 0 ? trimmed.slice(i + 1) : trimmed;
      return trimmed.length !== line.length ? `${kept}\r` : kept;
    })
    .join('\n');
}

function capStream(text: string): string {
  if (text.length <= MAX_STREAM_CHARS) return text;
  return `…（前面的输出太长，已省略 ${text.length - MAX_STREAM_CHARS} 个字符）\n${text.slice(-MAX_STREAM_CHARS)}`;
}

/** 往单元格的 outputs 追加一条；与上一条同名流合并（Jupyter 前端的做法） */
export function appendOutput(outputs: Y.Array<NbOutput>, out: NbOutput) {
  if (out.output_type === 'stream' && outputs.length > 0) {
    const last = outputs.get(outputs.length - 1);
    if (last.output_type === 'stream' && last.name === out.name) {
      const merged: NbOutput = {
        output_type: 'stream',
        name: out.name,
        text: capStream(fixConsole(last.text + out.text)),
      };
      outputs.delete(outputs.length - 1, 1);
      outputs.push([merged]);
      return;
    }
  }
  if (out.output_type === 'stream') {
    outputs.push([{ ...out, text: capStream(fixConsole(out.text)) }]);
    return;
  }
  outputs.push([out]);
}

/** update_display_data：整本里找同 display_id 的输出原地替换 */
export function updateDisplay(doc: Y.Doc, displayId: string, out: NbOutput) {
  for (const cell of cellsOf(doc).toArray()) {
    const outputs = cell.get('outputs');
    if (!(outputs instanceof Y.Array)) continue;
    const arr = outputs as Y.Array<NbOutput>;
    for (let i = 0; i < arr.length; i += 1) {
      const o = arr.get(i);
      if (o.output_type === 'display_data' && o.transient?.display_id === displayId) {
        arr.delete(i, 1);
        arr.insert(i, [out]);
      }
    }
  }
}
