import type { ResearchField, ResearchMethod, ResearchTemplate } from './research';
import { RESEARCH_METHOD_LABEL } from './research';
import { tr } from './i18n';

type FieldSpec = [id: string, label: string, type?: ResearchField['type'], unit?: string];
interface Outline {
  description: string;
  fields: FieldSpec[];
  steps: string[][];
}

/** 方法不决定学科、agent 角色或模型。字段均可选，避免要求研究者编造缺失内容。 */
const outlines: Record<ResearchMethod, Outline> = {
  general: {
    description: tr('围绕问题组织材料、过程和解释，适用于方法尚未确定或跨方法的工作。'),
    fields: [
      ['scope', tr('研究范围')],
      ['approach', tr('方法与选择依据')],
      ['materials', tr('材料与获取方式')],
      ['analysis', tr('分析与解释')],
      ['limitations', tr('局限与未解决问题')],
    ],
    steps: [
      [tr('明确问题'), tr('说明范围与目标产出')],
      [tr('安排研究'), tr('区分原计划与后续调整')],
      [tr('整理依据'), tr('来源可定位'), tr('保留不同或相反的材料')],
      [tr('形成解释'), tr('注明不确定性和适用条件')],
      [tr('交付与审阅'), tr('检查引用位置'), tr('区分完成状态与审阅结果')],
    ],
  },
  computational: {
    description: tr('记录数据、代码、计算配置和实际输出；可关联 Notebook 或导入外部运行结果。'),
    fields: [
      ['input', tr('输入数据及版本'), 'resource'],
      ['code', tr('代码或模型版本'), 'resource'],
      ['configuration', tr('参数、环境与随机性设置')],
      ['comparison', tr('比较方案与评价依据')],
      ['execution', tr('执行位置与运行标识')],
      ['analysis', tr('结果分析与复现限制')],
    ],
    steps: [
      [tr('确定计算方案'), tr('区分计算目标与验证依据')],
      [tr('固定输入与配置'), tr('关联输入版本'), tr('适用时记录随机性设置')],
      [tr('记录实际运行'), tr('注明工具输出或外部运行来源'), tr('记录失败和异常')],
      [tr('比较与分析'), tr('注明比较条件'), tr('保留不支持预期的结果')],
      [tr('交付与复核'), tr('检查复现条件及局限')],
    ],
  },
  experimental: {
    description: tr('记录实体实验的方法版本、样品、条件、观测和偏差，关联原始文件与分析。'),
    fields: [
      ['protocol', tr('方法文件及版本'), 'resource'],
      ['samples', tr('样品编号与处理')],
      ['conditions', tr('仪器、条件及单位')],
      ['measurement', tr('关键观测值'), 'number'],
      ['deviations', tr('偏离方案与异常')],
      ['analysis', tr('结果解释与限制')],
    ],
    steps: [
      [tr('固定实验方案'), tr('保存实际采用的方法版本'), tr('标明对照与重复安排（如适用）')],
      [tr('登记材料和条件'), tr('使用研究内样品编号'), tr('记录单位或注明原资料未提供')],
      [tr('记录操作与观测'), tr('保留原始文件'), tr('记录偏差与异常')],
      [tr('整理分析'), tr('区分团队观测和他人公开数据'), tr('每项结果注明来源')],
      [tr('解释与审阅'), tr('保留不支持假设的结果'), tr('写明适用条件')],
    ],
  },
  observational: {
    description: tr('支持问卷结果、田野及持续观测，记录采集设计、变量、缺失情况和分析依据。'),
    fields: [
      ['design', tr('研究设计与采集范围')],
      ['variables', tr('变量字典与单位')],
      ['data', tr('去标识数据'), 'resource'],
      ['sampleSize', tr('记录数量'), 'number', tr('条')],
      ['cleaning', tr('缺失值、排除与清洗说明')],
      ['analysis', tr('分析结果与解释边界')],
    ],
    steps: [
      [tr('说明对象与范围'), tr('说明样本来源与选择依据'), tr('不将方便样本表述为总体代表')],
      [tr('登记采集设计'), tr('保留变量定义与单位')],
      [tr('整理观测材料'), tr('使用脱敏资料'), tr('保留原始数据版本')],
      [tr('处理与分析'), tr('保留清洗依据'), tr('区分相关性描述与因果解释')],
      [tr('报告结果'), tr('注明样本、测量与设计局限')],
    ],
  },
  qualitative: {
    description: tr('支持访谈稿、观察笔记和公开文本的片段编码、分析备忘及主题比较。'),
    fields: [
      ['sampling', tr('材料选择与研究立场')],
      ['cases', tr('研究对象代号与说明')],
      ['transcript', tr('转写或整理稿'), 'resource'],
      ['codingApproach', tr('编码方法与调整依据')],
      ['memo', tr('分析备忘与反思')],
      ['counterexamples', tr('反例、分歧与解释边界')],
    ],
    steps: [
      [tr('界定材料与立场'), tr('研究对象与编码主题分别登记')],
      [tr('保存原文与整理稿'), tr('使用脱敏材料'), tr('摘录可回到原文'), tr('关联原件与整理稿')],
      [tr('编码与备忘'), tr('AI 建议保留作者标记'), tr('记录编码定义的调整')],
      [tr('比较主题与反例'), tr('保留不符合当前解释的片段'), tr('不把出现频次直接当作重要性')],
      [tr('形成解释'), tr('区分原文与研究者解释'), tr('说明材料和方法局限')],
    ],
  },
  literature: {
    description: tr('支持论文、书籍、手稿和其他史料，保留检索、筛选、版本、摘录及考证。'),
    fields: [
      ['search', tr('检索式、渠道与范围')],
      ['screening', tr('纳入排除及原因')],
      ['edition', tr('版本、年代与来源')],
      ['sourceCriticism', tr('来源考证与语境')],
      ['comparison', tr('相互印证与矛盾')],
      ['argument', tr('综合论证及限制')],
    ],
    steps: [
      [tr('界定研究范围'), tr('检索与筛选过程可追溯')],
      [tr('登记资料'), tr('保存作者、版本及可得的来源信息'), tr('来源无需 DOI 或电子全文')],
      [tr('核对版本与语境'), tr('标明仅据摘要或转引'), tr('不能核实的信息留待核实')],
      [tr('摘录与比较'), tr('保留矛盾证据'), tr('不混用不同版本页码')],
      [tr('形成论证'), tr('区分来源原话与解释'), tr('说明材料缺口与解释范围')],
    ],
  },
  theoretical: {
    description: tr('组织定义、前提、命题、推导和反例；形式验证仅在实际工具运行后标记。'),
    fields: [
      ['definitions', tr('定义与符号')],
      ['assumptions', tr('前提与适用条件')],
      ['statement', tr('命题或待解释关系')],
      ['derivation', tr('推导步骤与依据')],
      ['counterexamples', tr('反例与证明缺口')],
      ['verification', tr('检查方式与实际验证结果')],
    ],
    steps: [
      [tr('明确概念和问题'), tr('说明对象及量词范围')],
      [tr('列出前提'), tr('区分假设和待证明部分'), tr('引用前提可定位')],
      [tr('组织推导'), tr('逐步记录依赖'), tr('标明证明缺口')],
      [tr('检查反例与边界'), tr('不把有限样例当作一般证明')],
      [tr('整理与审阅'), tr('说明结论成立的条件'), tr('未运行证明器时不称为机器验证')],
    ],
  },
};

/** 已发布的预置版本不得原地升级；后续追加版本并由记录显式采用。 */
export const PRESET_RESEARCH_TEMPLATES: ResearchTemplate[] = (
  Object.keys(outlines) as ResearchMethod[]
).map((method) => ({
  id: `rtpl_preset_${method}`,
  projectId: null,
  version: 1,
  method,
  name: RESEARCH_METHOD_LABEL[method],
  description: outlines[method].description,
  fields: outlines[method].fields.map(([id, label, type = 'text', unit], order) => ({
    id,
    label,
    type,
    unit: unit ?? null,
    required: false,
    options: [],
    order,
    active: true,
  })),
  steps: outlines[method].steps.map(([title, ...checks], order) => ({
    id: `step_${method}_${order + 1}`,
    title: title!,
    description: checks.join(tr('；')),
    checklist: checks.map((text, index) => ({
      id: `check_${method}_${order + 1}_${index + 1}`,
      text,
    })),
    order,
    active: true,
  })),
  published: true,
  createdBy: { kind: 'system', id: 'system', name: tr('系统') },
  createdAt: '2026-10-28T00:00:00.000Z',
  publishedAt: '2026-10-28T00:00:00.000Z',
}));
