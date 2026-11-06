import { describe, expect, it } from 'vitest';
import type { AgentStep } from '@srh/shared';
import {
  KNOWN_TOOLS,
  buildActivity,
  isChangeTool,
  summarizeCall,
  summarizeGroup,
  toolActionLabel,
  toolCallOf,
  type ToolCall,
} from './step-summary';

/** 服务端注册的全部工具（apps/server/src/agents/tools/*.ts + harness/index.ts） */
const SERVER_TOOLS = [
  'computer_start',
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_open_url',
  'computer_exec',
  'list_files',
  'read_file',
  'write_file',
  'reply',
  'post_message',
  'update_status',
  'update_message',
  'react',
  'unreact',
  'no_reply_needed',
  'set_thread_label',
  'set_thread_resolved',
  'ask_decision',
  'close_decision',
  'send_to_coordinator',
  'start_thread',
  'message_thread',
  'list_documents',
  'read_document',
  'create_document',
  'edit_document',
  'list_experiments',
  'read_experiment',
  'create_experiment',
  'log_experiment',
  'update_experiment',
  'create_card',
  'update_card',
  'create_todo',
  'request_review',
  'draft_report',
  'library_search',
  'library_read',
  'library_import',
  'library_cite',
  'load_skill',
  'read_skill_file',
  'update_goal',
  'list_threads',
  'fetch_thread',
  'fetch_timeline',
  'fetch_messages',
  'list_members',
  'search_project',
  'memory_list',
  'memory_read',
  'memory_write',
  'list_claims',
  'check_conflicts',
  'claim',
  'renew_claim',
  'release_claim',
  'web_search',
  'paper_search',
  'fetch_url',
  'list_notebooks',
  'read_notebook',
  'edit_notebook',
  'run_notebook_cells',
];

let n = 0;
function step(kind: AgentStep['kind'], over: Partial<AgentStep> = {}): AgentStep {
  n += 1;
  return {
    id: `st_${n}`,
    sessionId: 'agt_1',
    turnId: 't1',
    index: n,
    kind,
    name: null,
    content: '',
    data: {},
    createdAt: `2026-10-26T08:00:${String(n % 60).padStart(2, '0')}Z`,
    ...over,
  };
}

function call(name: string, args: unknown, result?: unknown, ok = true): ToolCall {
  const c = step('tool_call', {
    name,
    content: JSON.stringify(args),
    data: { callId: `c${n}` },
  });
  const r =
    result === undefined
      ? null
      : step('tool_result', {
          name,
          content: typeof result === 'string' ? result : JSON.stringify(result),
          data: { callId: c.data.callId, ok },
        });
  return toolCallOf(c, r);
}

const JSONISH = /[{}[\]"]|_id\b|[a-z]+_[a-z]+/u;

describe('每个工具都有中文说法', () => {
  it('服务端注册的工具全部收录', () => {
    expect([...SERVER_TOOLS].sort()).toEqual([...KNOWN_TOOLS].sort());
  });

  it.each(SERVER_TOOLS)('%s：一句中文，不出现工具名和 JSON', (name) => {
    const s = summarizeCall(call(name, {}, { ok: true }));
    expect(s.text).toMatch(/[\u4e00-\u9fa5]/u);
    expect(s.text).not.toContain(name);
    expect(s.text).not.toMatch(JSONISH);
    expect(toolActionLabel(name)).toBeTruthy();
  });

  it('不认识的工具兜底：不打印名字和 JSON', () => {
    const s = summarizeCall(call('frobnicate_things', { x: 1 }, { ok: true, y: [1] }));
    expect(s.text).toBe('执行了一步操作');
    expect(s.outcome).toBeNull();
    const failed = summarizeCall(call('frobnicate_things', {}, { weird: true }, false));
    expect(failed.outcome).toBe('没成功：原因见原始数据');
  });

  it('MCP 工具说成外部工具', () => {
    const s = summarizeCall(call('mcp__zotero__search_items', { q: 'x' }, { items: [] }));
    expect(s.text).toBe('调用了外部工具「search_items」（zotero）');
  });
});

describe('参数和结果写进句子', () => {
  const docTitle = (id: string) => (id === 'doc_plan' ? '计划' : undefined);

  it('文档：标题优先取结果，其次文档列表', () => {
    expect(
      summarizeCall(call('read_document', { doc_id: 'doc_plan' }, { markdown: '' }), { docTitle })
        .text,
    ).toBe('读了文档《计划》');
    expect(
      summarizeCall(call('read_document', { doc_id: 'doc_x' }, { meta: { title: '开题报告' } }))
        .text,
    ).toBe('读了文档《开题报告》');
    expect(summarizeCall(call('read_document', { doc_id: 'doc_x' })).text).toBe('读了一份文档');
  });

  it('改文档：哪份、哪一节、改动规模', () => {
    const s = summarizeCall(
      call(
        'edit_document',
        { doc_id: 'doc_plan', op: 'replace_section', heading: '9. 结果表', markdown: 'a\nb\n\nc' },
        { ok: true, title: '计划' },
      ),
    );
    expect(s.text).toBe('改写了《计划》的「9. 结果表」一节');
    expect(s.diff).toBe('整节替换为 3 行');
    expect(s.tone).toBe('success');

    const t = summarizeCall(
      call(
        'edit_document',
        { doc_id: 'doc_plan', op: 'replace_text', find: '旧的', replace: '新的字' },
        { ok: true },
      ),
      { docTitle },
    );
    expect(t.text).toBe('改了《计划》里的一处文字');
    expect(t.diff).toBe('−2 字 +3 字');
  });

  it('失败时用中文原因，不出 JSON', () => {
    const s = summarizeCall(
      call(
        'edit_document',
        { doc_id: 'doc_plan', op: 'append', markdown: 'x' },
        { error: '文档里找不到这一节', code: 'not_found' },
        false,
      ),
      { docTitle },
    );
    expect(s.tone).toBe('error');
    expect(s.outcome).toBe('没成功：文档里找不到这一节');
    expect(s.diff).toBeNull();
  });

  it('检索：arXiv、结果条数', () => {
    const s = summarizeCall(
      call(
        'paper_search',
        { query: 'diffusion segmentation', sources: ['arxiv'] },
        { results: [{}, {}, {}] },
      ),
    );
    expect(s.text).toBe('搜索了 arXiv：diffusion segmentation');
    expect(s.outcome).toBe('3 篇论文');
    expect(summarizeCall(call('web_search', { query: ['a', 'b'] }, { results: [] })).outcome).toBe(
      '没有结果',
    );
  });

  it('Notebook：运行了几个单元格、有没有出错', () => {
    const ok = summarizeCall(
      call('run_notebook_cells', { notebook_id: 'nb_1' }, { finished: true, cells: [{}, {}, {}] }),
    );
    expect(ok.text).toBe('在 Notebook 里运行了 3 个单元格');
    expect(ok.outcome).toBe('全部跑通');
    const bad = summarizeCall(
      call('run_notebook_cells', {}, { finished: true, cells: [{ failed: true }, {}] }),
    );
    expect(bad.outcome).toBe('1 个单元格出错');
    expect(
      summarizeCall(
        call(
          'edit_notebook',
          { ops: [{ op: 'insert' }, { op: 'insert' }, { op: 'delete' }] },
          { ok: true },
        ),
      ).text,
    ).toBe('在 Notebook 里新增了 2 个单元格、删了 1 个');
  });

  it('认领文档的一节、云电脑命令的退出码', () => {
    expect(
      summarizeCall(
        call(
          'claim',
          { resource_kind: 'doc_section', resource_ref: 'doc_plan#3. 方法' },
          { ok: true },
        ),
        { docTitle },
      ).text,
    ).toBe('认领了《计划》的「3. 方法」一节');
    expect(
      summarizeCall(call('computer_exec', { command: 'ls' }, { exit_code: 2, stdout: '' })).outcome,
    ).toBe('运行失败（退出码 2）');
  });

  it('还没结果：tone neutral、没有结论', () => {
    const s = summarizeCall(call('web_search', { query: 'x' }));
    expect(s.tone).toBe('neutral');
    expect(s.outcome).toBeNull();
  });
});

describe('分组', () => {
  it('读多份文档合成一句', () => {
    const g = summarizeGroup([
      call('read_document', {}, { meta: { title: 'A' } }),
      call('read_document', {}, { meta: { title: 'B' } }),
    ]);
    expect(g.text).toBe('读了 2 份文档：《A》《B》');
  });

  it('云电脑各步合成一组；失败次数写出来', () => {
    const g = summarizeGroup([
      call('computer_screenshot', {}, {}),
      call('computer_click', {}, { error: '点不到' }, false),
      call('computer_type', { text: 'x' }, { ok: true }),
    ]);
    expect(g.text).toBe('在云电脑上操作了 3 步');
    expect(g.outcome).toBe('其中 1 次没成功');
    expect(g.tone).toBe('error');
  });

  it('同一句重复时写次数', () => {
    expect(
      summarizeGroup([call('update_status', {}, {}), call('update_status', {}, {})]).text,
    ).toBe('更新了计划（2 次）');
  });
});

describe('buildActivity', () => {
  it('按 callId 配对，连续同类合并，思考合成一块', () => {
    const t1 = step('thinking', { content: 'Hmm' });
    const t2 = step('thinking', { content: 'Maybe' });
    const c1 = step('tool_call', { name: 'computer_click', content: '{}', data: { callId: 'a' } });
    const c2 = step('tool_call', { name: 'computer_type', content: '{}', data: { callId: 'b' } });
    const r2 = step('tool_result', {
      name: 'computer_type',
      content: '{"ok":true}',
      data: { callId: 'b', ok: true },
    });
    const r1 = step('tool_result', {
      name: 'computer_click',
      content: '{"ok":true}',
      data: { callId: 'a', ok: true },
    });
    const text = step('text', { content: '好了' });
    const items = buildActivity([t1, t2, c1, c2, r2, r1, text]);
    expect(items.map((i) => i.kind)).toEqual(['thinking', 'tools', 'text']);
    const tools = items[1]!;
    if (tools.kind !== 'tools') throw new Error('expected tools');
    expect(tools.calls.map((c) => c.result?.id)).toEqual([r1.id, r2.id]);
    const thinking = items[0]!;
    if (thinking.kind !== 'thinking') throw new Error('expected thinking');
    expect(thinking.steps).toHaveLength(2);
  });

  it('调用在更早一页时，结果单独成一条', () => {
    const r = step('tool_result', {
      name: 'web_search',
      content: '{"results":[]}',
      data: { callId: 'zz', ok: true },
    });
    const items = buildActivity([r]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('tools');
  });
});

describe('isChangeTool', () => {
  it('写入类算改动，汇报进度和读取不算', () => {
    expect(isChangeTool('edit_document')).toBe(true);
    expect(isChangeTool('write_file')).toBe(true);
    expect(isChangeTool('edit_notebook')).toBe(true);
    expect(isChangeTool('update_status')).toBe(false);
    expect(isChangeTool('update_goal')).toBe(false);
    expect(isChangeTool('read_document')).toBe(false);
    expect(isChangeTool('mcp__x__create_thing')).toBe(false);
    expect(isChangeTool('commit')).toBe(true);
  });
});
