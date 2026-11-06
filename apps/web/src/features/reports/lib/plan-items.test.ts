import { describe, expect, it } from 'vitest';
import {
  extractPlanEntries,
  extractPlanItems,
  isPlanHeading,
  matchAssignee,
  MAX_PLAN_ITEMS,
} from './plan-items';

const REPORT = `# 组会汇报 · 10月20日–10月26日

## 本周进展

- 完成基线复现
- 不是计划

## 下周计划

- 完成 **消融实验**（3 组）
  - 子项：先跑 lr 扫描
- [ ] 在 CIFAR-100 上验证泛化性
1. 整理 \`exp-003\` 的实验记录

### 细节说明

- 也属于下周计划小节（更深的标题不结束小节）

## 问题与讨论

- 这一条不应出现
`;

describe('extractPlanItems', () => {
  it('抽取“下周计划”小节最浅一层的列表项，并清洗 markdown 记号', () => {
    expect(extractPlanItems(REPORT)).toEqual([
      '完成 消融实验（3 组）',
      '在 CIFAR-100 上验证泛化性',
      '整理 exp-003 的实验记录',
      '也属于下周计划小节（更深的标题不结束小节）',
    ]);
  });

  it('识别多种标题写法：序号、冒号、英文、加粗伪标题', () => {
    expect(isPlanHeading('四、下期计划：')).toBe(true);
    expect(isPlanHeading('3. Next Steps')).toBe(true);
    expect(isPlanHeading('（2）后续计划')).toBe(true);
    expect(isPlanHeading('本周进展')).toBe(false);

    const md = `**下一步：**\n\n- 写方法部分\n- 画架构图\n\n**风险**\n\n- 不算`;
    expect(extractPlanItems(md)).toEqual(['写方法部分', '画架构图']);
  });

  it('英文 Next steps 小节，到同级标题结束', () => {
    const md = `## Results\n- a\n## Next steps\n* run ablation\n+ write paper\n## Q&A\n- nope`;
    expect(extractPlanItems(md)).toEqual(['run ablation', 'write paper']);
  });

  it('多个计划小节合并、去重；忽略代码块里的伪标题', () => {
    const md = [
      '## 下周计划',
      '- 跑实验',
      '## 讨论',
      '```md',
      '## 下周计划',
      '- 代码块里的不算',
      '```',
      '## 下期计划',
      '- 跑实验',
      '- 写周报',
    ].join('\n');
    expect(extractPlanItems(md)).toEqual(['跑实验', '写周报']);
  });

  it('没有计划小节或小节为空时返回空数组', () => {
    expect(extractPlanItems('## 本周进展\n- a')).toEqual([]);
    expect(extractPlanItems('## 下周计划\n\n暂无。\n')).toEqual([]);
    expect(extractPlanItems('')).toEqual([]);
  });

  it('真实汇报里的写法：去掉 [文字](#id) 链接记号、负责人和来源注记', () => {
    const md = [
      '## 下周计划',
      '- ProtoNet 基线换 ResNet-12：负责人小模，来源为实验记录结论。[实验记录](#exp_01M5W3X24P6G71MWF1TW7FXG0S)',
      '- 补 5-shot 结果（负责人：王导）',
      '- @张三：整理 [miniImageNet 划分](#doc_abc)（来源：[线程](#thr_in)）',
      '- 由李四负责，复核 [消融结果](#elg_1)',
    ].join('\n');
    expect(extractPlanEntries(md)).toEqual([
      { title: 'ProtoNet 基线换 ResNet-12', owner: '小模' },
      { title: '补 5-shot 结果', owner: '王导' },
      { title: '整理 miniImageNet 划分', owner: '张三' },
      { title: '复核 消融结果', owner: '李四' },
    ]);
    expect(extractPlanItems(md)[0]).toBe('ProtoNet 基线换 ResNet-12');
  });

  it('负责人名字匹配成员或 agent：精确优先，包含关系只在唯一时预填', () => {
    const options = [
      { value: 'usr_wang', label: '王导师' },
      { value: 'usr_xm', label: '小模' },
      { value: 'usr_xm2', label: '小模二号' },
      { value: 'agent:thr_1', label: '消融实验线程' },
    ];
    expect(matchAssignee('小模', options)).toBe('usr_xm');
    expect(matchAssignee('王导', options)).toBe('usr_wang');
    expect(matchAssignee('@消融实验线程', options)).toBe('agent:thr_1');
    expect(matchAssignee('小', options)).toBeNull();
    expect(matchAssignee('路人', options)).toBeNull();
    expect(matchAssignee(null, options)).toBeNull();
  });

  it('限制条数与长度', () => {
    const md = `## 下周计划\n${Array.from({ length: 60 }, (_, i) => `- 第 ${i} 条`).join('\n')}\n- ${'长'.repeat(300)}`;
    const items = extractPlanItems(md);
    expect(items).toHaveLength(MAX_PLAN_ITEMS);
    expect(extractPlanItems(`## 下周计划\n- ${'长'.repeat(300)}`)[0]).toHaveLength(200);
  });
});
