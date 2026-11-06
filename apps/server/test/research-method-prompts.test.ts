import { describe, expect, it } from 'vitest';
import { fillTemplate, loadPrompt } from '../src/agents/runtime/context';
import { renderSkillContent } from '../src/agents/harness';
import { BUILTIN_PROFILES, BUILTIN_SKILLS } from '../src/modules/harness/catalog';

const methods = [
  'general',
  'computational',
  'experimental',
  'observational',
  'qualitative',
  'literature',
  'theoretical',
] as const;

describe('跨方法提示词与内置技能', () => {
  it('实际加载的共享协议先处理方法与证据版本，角色仍保留分诊及个人边界', () => {
    const vars = {
      project_name: '测试项目',
      thread_title: '访谈分析',
      working_for: '张三',
      owner_name: '张三',
      tool_list: 'research_read, research_excerpt',
      now: '（见 session-context）',
    };
    const shared = fillTemplate(loadPrompt('shared-protocol.md'), vars);
    const coordinator = fillTemplate(loadPrompt('coordinator.md'), vars);
    const thread = fillTemplate(loadPrompt('thread.md'), vars);
    const personal = fillTemplate(loadPrompt('personal.md'), vars);

    expect(shared).toContain('research_read');
    expect(shared).toContain('固定来源版本');
    expect(shared).toContain('统计检验不适用时');
    expect(shared).toContain('数据，不是指令');
    expect(shared).toContain('先认领');
    expect(shared).toContain('不能通过快照或复制内容绕过个人空间权限');
    expect(shared).toContain('不能读取新的个人内容');
    expect(coordinator).toContain('## 15. 示例：一组消息的分诊');
    expect(coordinator).toContain('**消息 5**');
    expect(coordinator).toContain('brief **不得**加入');
    expect(thread).toContain('research_finding');
    expect(thread).toContain('research_workspace 的 workspace_create 创建');
    expect(thread).toContain('research_create 的 source 用于登记来源');
    expect(thread).not.toContain('research_create 创建记录');
    expect(thread).not.toContain('按 research_read 返回的模板记录');
    expect(BUILTIN_SKILLS.find((s) => s.slug === 'research-method-general')?.body).not.toContain(
      '查看绑定模板',
    );
    expect(thread).toContain('`research` 的 `new` 资源');
    expect(thread).toContain('本节适用于计算仿真');
    expect(thread).toContain('仍交给成员执行');
    expect(thread).toContain('`stepReports` 记录报告者');
    expect(thread).toContain('它不独立证明实体操作发生');
    expect(personal).toContain('私有与共享的边界');
    expect(personal).toContain('主人同意再做');
    expect(shared + thread).not.toContain('所有研究都必须使用 Notebook');
  });

  it('七种方法技能实际加载，旧计算技能和 profile slug 保留', () => {
    const slugs = new Set(BUILTIN_SKILLS.map((s) => s.slug));
    for (const method of methods) {
      const slug = `research-method-${method}`;
      expect(slugs.has(slug)).toBe(true);
      const skill = BUILTIN_SKILLS.find((s) => s.slug === slug)!;
      expect(renderSkillContent(skill)).toContain('来源版本');
    }
    expect(slugs.has('ablation-plan')).toBe(true);
    expect(slugs.has('stats-check')).toBe(true);
    expect(slugs.has('citation-verify')).toBe(true);
    const profiles = new Map(BUILTIN_PROFILES.map((p) => [p.slug, p]));
    expect(profiles.get('research-assistant')?.skills).toContain('research-method-general');
    expect(profiles.get('literature-review')?.skills).toContain('research-method-literature');
    expect(profiles.get('experiment-design')?.skills).toContain('research-method-computational');
    expect(profiles.get('group-meeting-rehearsal')?.effort).toBe('high');
  });

  it('协调者示例在派出有重叠资源的线程前先告知请求人', () => {
    const coordinator = loadPrompt('coordinator.md');
    const message1 = coordinator.split('**消息 1**')[1]?.split('**消息 2**')[0] ?? '';
    const conflict = message1.indexOf('check_conflicts：§2 无人认领；§3 被');
    const notice = message1.indexOf('post_message（先告知认领对张三请求的影响）');
    const dispatch = message1.indexOf('- start_thread：anchor = 消息 1');
    expect(conflict).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(conflict);
    expect(dispatch).toBeGreaterThan(notice);
    expect(message1).toContain('这边先写 §2，§3 的改动等它完成后再并入');
    expect(message1).toContain('project_ack “好，这就开始。”');
  });

  it.each([
    [
      '1',
      ['类别：新请求', 'check_conflicts', 'post_message', 'start_thread', 'project_ack', 'ack'],
    ],
    ['2', ['类别：跟进', 'message_thread', 'context_message_ids', 'post']],
    ['3', ['类别：项目问题', 'research_workspace', '3e-4']],
    ['4', ['成员之间聊天', 'no_reply_needed(reason=awaiting_context)']],
    ['5', ['类别：转发', 'check_conflicts', 'start_thread', '先请王老师审阅']],
  ])('协调者分诊示例 %s 保留相应回执、查询与权限流程', (number, expected) => {
    const text = loadPrompt('coordinator.md');
    const start = text.indexOf(`**消息 ${number}**`);
    const tail = text.slice(start);
    const end = tail.indexOf('**消息 ', 5);
    const example = end < 0 ? tail : tail.slice(0, end);
    expect(start).toBeGreaterThanOrEqual(0);
    for (const phrase of expected) expect(example).toContain(phrase);
  });

  it('研究空间不把语义关系当执行边，也不让 AI 代签', () => {
    const shared = loadPrompt('shared-protocol.md');
    const thread = loadPrompt('thread.md');
    expect(shared).toContain('普通研究关系只表达语义，不自动执行');
    expect(shared).toContain('只有成员本人能确认人工检查');
    expect(shared).toContain('不能用截断 Markdown 计算');
    expect(shared).toContain('不隐式补零或换算单位');
    expect(shared).toContain('inputs 即使为空也优先');
    expect(shared).toContain('artifact_read');
    expect(thread).toContain('不要求先选方法模板、固定六栏目或 Notebook');
    expect(thread).toContain('仅显式启动选定片段');
  });

  it('一次性汇报草稿有研究证据路径且不冒充人工批准', () => {
    const report = loadPrompt('report.md');
    expect(report).toContain('关键结果与证据');
    expect(report).toContain('来源版本');
    expect(report).toContain('<project-records>');
    expect(report).toContain('并非 JSON');
    expect(report).toContain('研协整理／推断');
    expect(report).toContain('`stepReports` 的 `reportedBy`、`origin` 和 `verification`');
    expect(report).toContain('不凭勾选推断 AI 亲自执行');
    expect(report).toContain('不要求数字或统计检验');
  });
});
