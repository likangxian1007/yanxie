import {
  BadgeCheck,
  Bell,
  BookMarked,
  CalendarClock,
  Cpu,
  FileText,
  Globe,
  GraduationCap,
  Inbox,
  Library,
  ListTodo,
  ListTree,
  MessagesSquare,
  NotebookTabs,
  Plug,
  Presentation,
  SquareKanban,
  SquareSlash,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { tr } from '@/lib/i18n';

/**
 * 帮助中心的文案。按模块组织：是什么 → 典型流程 → 一个具体的科研例子 → 小技巧。
 * 锚点（id）和模块介绍条的“了解更多”一一对应，改名时两边一起改。
 */

export interface HelpModule {
  id: string;
  title: string;
  icon: LucideIcon;
  /** 侧栏里的路径（相对 /p/:projectId），用来放“打开”链接；没有独立页面时不写 */
  to?: string;
  what: string;
  steps: string[];
  example: string;
  tips: string[];
  /** 触屏设备上换掉的步骤 / 小技巧（不讲键盘快捷键）；不写就用上面的 */
  touch?: { steps?: string[]; tips?: string[] };
}

/** 按设备取模块文案：触屏上用 touch 里的说法 */
export function localizeModule(m: HelpModule, touch: boolean): HelpModule {
  if (!touch || !m.touch) return m;
  return { ...m, steps: m.touch.steps ?? m.steps, tips: m.touch.tips ?? m.tips };
}

export const HELP_MODULES: HelpModule[] = [
  {
    id: 'coordinator',
    title: tr('协作台'),
    icon: MessagesSquare,
    to: '',
    what: tr(
      '整个课题共用的对话流。所有成员面对同一个协调者：你描述需求，它结合项目记忆和已有进展拟定计划，再拆成线程交给 agent 并行推进。',
    ),
    steps: [
      tr('在底部输入框写清目标、已有材料和约束，Enter 发送，Shift + Enter 换行。'),
      tr('协调者回复计划；遇到需要你决定的地方，会给出带选项的决策卡片。'),
      tr('计划确定后，线程卡片挂在原消息下面，点开就能看进度。'),
      tr('有新想法直接在协作台补充，协调者会据此调整计划。'),
    ],
    example: tr(
      '「在 BraTS 2021 上复现 MedSegDiff，和 nnU-Net 基线比较 Dice 与 HD95，算力只有两张 3090。」协调者可能拆成文献与代码调研、数据预处理、训练复现、对比实验四个线程。',
    ),
    tips: [
      tr('打开输入框下方的「旁聊」，消息只有成员能看到，协调者读不到。'),
      tr('agent 正在回复时，发送按钮会变成停止按钮，可以随时打断。'),
      tr('访客只能查看，不能在协作台发言。'),
    ],
  },
  {
    id: 'workspace',
    title: tr('我的工作区'),
    icon: UserRound,
    to: 'workspace',
    what: tr(
      '你和个人 agent 的私人会话，别人看不到。适合在拿到全组面前之前，先自己查资料、理思路、写草稿。',
    ),
    steps: [
      tr('点「新建会话」，直接提问或贴材料。'),
      tr('来回讨论，把方案聊清楚。'),
      tr('需要团队接手时，点会话顶部的「转给协调者」，可以附一句说明。'),
      tr('转出后，协调者会在协作台里接着安排。'),
    ],
    example: tr(
      '先让个人 agent 比较三种条件注入方式、估算显存占用，确定用哪种后再转给协调者，免得把没想清楚的方案直接抛给全组。',
    ),
    tips: [
      tr('转出前可以预览要分享的内容。'),
      tr('已转出的会话在列表里带「已转给协调者」标记。'),
      tr('⌘K 里的「新建个人会话」可以从任何页面直接开一个。'),
    ],
    touch: {
      tips: [
        tr('转出前可以预览要分享的内容。'),
        tr('已转出的会话在列表里带「已转给协调者」标记。'),
        tr('点顶部的放大镜搜「新建个人会话」，可以从任何页面直接开一个。'),
      ],
    },
  },
  {
    id: 'threads',
    title: tr('线程'),
    icon: ListTree,
    to: 'threads',
    what: tr('协调者拆出来的每一项工作都是一个线程，由一个 agent 负责，按进度清单一步步推进。'),
    steps: [
      tr('在线程页按状态浏览：进行中、等你处理、待验收、已完成。'),
      tr('打开线程看进度清单：✓ 已完成、✱ 进行中、○ 未开始。'),
      tr('在线程里回复，agent 会接着做；需要你拍板时它会停下来等你。'),
      tr('产出（文档、代码、图表）和改动列在线程里，做完可以请导师审阅。'),
    ],
    example: tr(
      '「训练复现」线程的清单可能是：✓ 下载 BraTS 2021 并转成 NIfTI；✱ 跑通官方训练脚本；○ 把 Dice 和 HD95 记到研究空间记录。',
    ),
    tips: [
      tr('常用的线程点「置顶」，会出现在侧栏里。'),
      tr('线程页可以在列表和看板两种视图之间切换。'),
    ],
  },
  {
    id: 'docs',
    title: tr('文档'),
    icon: FileText,
    to: 'docs',
    what: tr(
      '课题组共用的文档、表格、幻灯片和 LaTeX 论文。成员和 agent 可以同时编辑，改动实时同步。',
    ),
    steps: [
      tr('在文档页新建，选文档、表格、幻灯片或 LaTeX 论文。'),
      tr('同学打开同一篇就能一起写，页面上能看到谁正在看、谁在编辑。'),
      tr('让 agent 改写或补充时，它会先认领要改的段落，再动手。'),
      tr('写完点「请求审阅」，请导师或同学把关。'),
    ],
    example: tr(
      '论文的 Related Work：你写引言，同学补实验设置，agent 根据线程里的调研结果整理对比表，三个人同时编辑互不覆盖。',
    ),
    tips: [
      tr('富文本里在空行按空格（或 ⌘J）唤起 AI 助手。'),
      tr('选中文字后按 ⌘⌥M 添加评论，可以 @ 成员。'),
      tr('LaTeX 论文按 ⌘S 立即编译（服务器开启编译时）；幻灯片按 F5 开始放映。'),
    ],
  },
  {
    id: 'board',
    title: tr('看板'),
    icon: SquareKanban,
    to: 'board',
    what: tr('用卡片和列管理课题任务，适合排期、分工，以及组会前过一遍进度。'),
    steps: [
      tr('按需要建列，例如「待开始」「进行中」「已完成」。'),
      tr('添加卡片，指派给成员或 agent，关联线程。'),
      tr('拖动卡片换列，进度一眼可见。'),
    ],
    example: tr(
      '投稿前两周，把「补消融实验」「画框架图」「改摘要」做成卡片分给三个人，组会时一眼就能看出谁卡住了。',
    ),
    tips: [tr('一个课题可以有多个看板，例如按投稿和按日常工作分开。')],
  },
  {
    id: 'todos',
    title: tr('待办'),
    icon: ListTodo,
    to: 'todos',
    what: tr('课题共享待办和你的个人待办放在一起，记下那些不值得开一个线程的小事。'),
    steps: [
      tr('在顶部输入框写一条，回车保存。'),
      tr('用 !! 标记优先级，用 @ 指派给成员或 agent。'),
      tr('做完勾掉，完成的待办会收到「已完成」里。'),
    ],
    example: tr('「@小王 周五前把服务器驱动升级到 550」「!! 组会前把 Dice 曲线发到群里」。'),
    tips: [tr('指派给 agent 的待办会唤醒它开始做。')],
  },
  {
    id: 'reviews',
    title: tr('审阅'),
    icon: BadgeCheck,
    to: 'reviews',
    what: tr(
      '像代码评审里的 PR 一样，请别人看文档、研究空间、汇报或计划：逐条评论，最后给出 LGTM 或修改意见。',
    ),
    steps: [
      tr('在文档、研究空间或汇报页点「请求审阅」，选审阅人，写一句希望对方看什么。'),
      tr('审阅人在「待我处理」里收到请求，打开后可以逐条评论。'),
      tr('在「你的结论」里选 LGTM、要求修改或仅评论。'),
      tr('所有审阅人都 LGTM 后，审阅显示「已通过」，结论也会回到相关线程。'),
    ],
    example: tr(
      '投稿前把 LaTeX 论文发给导师审阅：导师在方法部分留了两条意见并点「要求修改」，你改完再发起一次，导师 LGTM。',
    ),
    tips: [tr('选「仅评论」时需要写一段说明。'), tr('发起人可以随时关闭审阅，评论记录会保留。')],
  },
  {
    id: 'reports',
    title: tr('组会汇报'),
    icon: Presentation,
    to: 'reports',
    what: tr(
      '选一个时间段，协调者根据这期间的线程、研究空间、审阅和文档改动写出汇报草稿，你修改后定稿。',
    ),
    steps: [
      tr('点「生成汇报」，选本周或自定义时间段。'),
      tr('协调者把这段时间的进展整理成一份草稿。'),
      tr('直接在草稿上修改，补上你自己的判断。'),
      tr('定稿后可以存成协同文档，或请导师提前审阅。'),
    ],
    example: tr(
      '周四组会前选「本周」生成：草稿列出了复现线程的进度、两组消融实验的 Dice 对比和还没解决的显存问题，你补两句分析就能讲。',
    ),
    tips: [tr('汇报只整理这个课题里的内容，不会混进别的课题。')],
  },
  {
    id: 'inbox',
    title: tr('待我处理'),
    icon: Inbox,
    to: 'inbox',
    what: tr(
      '所有需要你处理的事集中在一处：请你拍板的决策、请你审阅的内容、@你的消息、冲突预警和指派给你的工作。',
    ),
    steps: [
      tr('侧栏「待我处理」旁的数字是待处理数量，顶栏铃铛上也有提示点；手机上看底部标签栏的计数。'),
      tr('点一条，直接跳到要处理的位置。'),
      tr('处理完点对勾标为完成，键盘上按 E 也可以。'),
      tr('完成的事项收在「已完成」里，需要时可以移回待处理。'),
    ],
    example: tr(
      '早上打开研协先看这一页：一个线程在等你选数据增强方案，一份研究空间记录请你审阅，处理完列表就清空了。',
    ),
    tips: [tr('在列表里用 ↑ ↓ 移动，G 然后 I 可以从任何页面直接打开这里。')],
    touch: {
      steps: [
        tr('底部标签栏「待我处理」上的数字是待处理数量。'),
        tr('点一条，直接跳到要处理的位置。'),
        tr('处理完点条目右下角的对勾标为完成。'),
        tr('完成的事项收在「已完成」里，需要时可以移回待处理。'),
      ],
      tips: [tr('只想标记看过，点信封图标标为已读，事项会留在列表里。')],
    },
  },
];

/**
 * agent 能力与工具：斜杠指令、Skill、MCP、模型与强度、科研 profile、联网检索、文献库、Notebook、定时任务。
 * 只写代码里真实存在的功能（features/harness、settings/components/harness、library、notebooks，
 * 以及 server 的 agents/tools）。
 */
export const TOOL_MODULES: HelpModule[] = [
  {
    id: 'slash',
    title: tr('斜杠指令'),
    icon: SquareSlash,
    what: tr(
      '在协作台、线程和个人会话的输入框开头输入 /，会弹出指令菜单：设目标、先出计划、切模型、按某个 Skill 做事、停下 agent 等，不用记长句子。',
    ),
    steps: [
      tr('在输入框开头输入 / 和指令的前几个字，菜单按「指令」「Skill」「自定义」分组。'),
      tr('用 ↑ ↓ 选择，Enter 或 Tab 确认，Esc 关掉菜单。'),
      tr('指令后面可以接参数，例如「/goal 跑完三组消融并写进研究空间记录」。'),
    ],
    example: tr(
      '「/plan 在 CIFAR-100 上复现 ResNet-18 基线」让 agent 先列计划，你确认后才动手；跑偏了就发「/stop」停下这一轮。',
    ),
    tips: [
      tr(
        '常用指令：/goal（持续目标，/goal clear 清除）、/plan、/skill、/model、/effort、/profile、/clear、/compact、/stop、/help；个人会话里还有 /forward 转给协调者。',
      ),
      tr(
        '/model、/effort、/profile 不带参数会打开选择面板；这几条和 /clear、/compact、/stop 要等会话开始后才能用。',
      ),
      tr(
        '可以在「设置 → 指令」里新建自己的指令，模板里用 $ARGUMENTS 代表后面跟的内容。旁聊里的消息不会当成指令。',
      ),
    ],
    touch: {
      steps: [
        tr('在输入框开头输入 / 和指令的前几个字，菜单按「指令」「Skill」「自定义」分组。'),
        tr('点一条就会填进输入框。'),
        tr('指令后面可以接参数，例如「/goal 跑完三组消融并写进研究空间记录」。'),
      ],
    },
  },
  {
    id: 'skills',
    title: 'Skill',
    icon: BookMarked,
    to: 'settings?tab=skills',
    what: tr(
      '可复用的做事说明，例如「文献检索协议」「引用核验」「组会汇报」。agent 平时只看名字和用途，用到时才读正文；你也可以用 /名字 点名让它照着做。',
    ),
    steps: [
      tr('在「设置 → Skill」里看内置的 Skill，或点「新建 Skill」「导入 SKILL.md」。'),
      tr('写清「什么时候用」和正文（Markdown），可以附带文件。'),
      tr('打开「成员可点名」就能在 / 菜单里点它；打开「agent 可自选」，agent 会按用途自己加载。'),
    ],
    example: tr(
      '把组里的「消融实验写法」写成一个 Skill，之后在线程里发「/skill ablation-plan 对比三种数据增强」，agent 会按这套格式出计划。',
    ),
    tips: [
      tr('有三种范围：内置、项目、个人。同名时个人优先，其次项目，最后内置。'),
      tr('项目 Skill 由负责人和导师管理；个人 Skill 只在你自己的个人会话里生效。'),
      tr('内置 Skill 不能直接改，可以先「复制到项目」或「复制为个人」再改。'),
    ],
  },
  {
    id: 'mcp',
    title: 'MCP',
    icon: Plug,
    to: 'settings?tab=mcp',
    what: tr(
      '通过 MCP（Model Context Protocol）给 agent 接上外部工具，例如组里自己的数据服务。接好后 agent 可以直接调用这些工具。',
    ),
    steps: [
      tr(
        '在「设置 → MCP」点「添加服务器」，选连接方式：HTTP、SSE（旧版）或 stdio（需要部署方允许）。',
      ),
      tr(
        '填地址和请求头（stdio 填命令、参数和环境变量），再选「哪些 agent 能用」：协调者、线程 agent、个人 agent。',
      ),
      tr('保存后看状态是否「已连接」，可以逐个停用不想给 agent 用的工具。'),
    ],
    example: tr(
      '把实验室的数据集索引服务接成 MCP，线程 agent 就能自己查某个数据集的划分和存放路径，不用你每次贴给它。',
    ),
    tips: [
      tr('密钥（请求头、环境变量）保存后不会再显示。'),
      tr('项目范围的服务器由负责人和导师管理；个人范围的只给你的个人 agent 用。'),
      tr('连接出错时卡片上会显示错误信息，改好地址或请求头后点「重新连接」。'),
    ],
  },
  {
    id: 'notify',
    title: tr('通知到群'),
    icon: Bell,
    to: 'settings?tab=notify',
    what: tr(
      '项目里有事时（有人 @ 你、请你审阅、有张决策卡等你拍板），把一条只带「事件说明 + 链接」的消息推到你自己的飞书 / 企业微信 / 钉钉群。默认只推这类"等你处理"的事件。',
    ),
    steps: [
      tr('先在群里加一个「自定义机器人」——需要你是这个群的管理员，加好后复制它给的 Webhook 地址。'),
      tr(
        '在「设置 → 通知」点「新建订阅」，选平台、把地址粘进去保存。地址里带着密钥，所以列表只显示打码版。',
      ),
      tr('点这一行的「发测试」，去群里确认真的收到了；收不到就先看「投递记录」里写的失败原因。'),
      tr('需要时再勾别的事件（有新消息、线程有新进展等），默认只勾了收件箱那一类。'),
    ],
    example: tr(
      '把「图对比学习」项目的 @ 提醒同步到实验室飞书群：同学在讨论里 @ 你，群里立刻响一下，你点链接回来看正文，不用一直盯网页。',
    ),
    tips: [
      tr('本版只支持群机器人（只能往它所在的那一个群推）；单聊、应用机器人和签名校验都不支持。'),
      tr(
        '平台的安全设置里，关键词填「研协」；IP 白名单填服务器的出站 IP（找管理员要）；签名校验别开——本版没实现，开了会一直失败。',
      ),
      tr(
        '通知是整个群都能看到的，所以只发事件说明和链接，不带正文片段；旁聊和别人的收件箱不会外发。',
      ),
      tr('发失败会自动重试（1 分钟起），连续失败太多次会自动停用，并在你的收件箱里留一条提醒。'),
      tr('「新建订阅」是灰的＝服务器没开这个功能，找管理员。'),
    ],
  },
  {
    id: 'models',
    title: tr('模型与强度'),
    icon: Cpu,
    to: 'settings?tab=models',
    what: tr(
      '每个会话可以单独选用哪个模型、思考多深。推理强度有不思考、低、中、高、最高几档，具体能选哪几档看模型。',
    ),
    steps: [
      tr('在输入框工具栏点模型按钮（芯片图标），选模型和推理强度；也可以发 /model 或 /effort。'),
      tr('切换只影响当前这个会话，不影响别的线程。'),
      tr(
        '负责人和导师可以在「设置 → 模型」里「添加接口」，接入 OpenAI 兼容的模型服务，再「测试连接」。',
      ),
    ],
    example: tr(
      '日常整理文献用低强度更快；推导公式、设计实验时把这个线程切到高强度，让它多想一会儿。',
    ),
    tips: [
      tr('部署时用环境变量配置的接口在设置里只读。'),
      tr('会话开始（发出第一句话）后才能切换；访客不能修改模型。'),
    ],
  },
  {
    id: 'profiles',
    title: tr('科研 profile'),
    icon: GraduationCap,
    to: 'settings?tab=agent-profiles',
    what: tr(
      '给 agent 设定一个科研角色，例如「文献调研与综述」「实验设计与消融」「投稿前模拟审稿」。每个 profile 带一段角色设定、默认加载的 Skill、开场引导和建议的推理强度。',
    ),
    steps: [
      tr('在「我的工作区」新建会话时，在新会话页选一个 profile；选「通用」就是不加角色。'),
      tr('会话进行中也可以在输入框的模型面板里换，或发 /profile。'),
      tr('想要组里自己的角色，在「设置 → Profile」里「新建 profile」。'),
    ],
    example: tr('投稿前在个人会话里选「投稿前模拟审稿」，贴上论文，让它按审稿人的视角挑问题。'),
    tips: [tr('profile 和 Skill 一样分内置、项目、个人三种范围。')],
  },
  {
    id: 'web-search',
    title: tr('联网和学术检索'),
    icon: Globe,
    what: tr(
      '部署方开启联网后，线程 agent 和个人 agent 可以搜网页、查论文、读公开网页和 PDF。论文检索会同时查 OpenAlex、Semantic Scholar、Crossref 和 arXiv，并按 DOI / arXiv 号去重。',
    ),
    steps: [
      tr('直接在线程或个人会话里让 agent 查，例如「找 2023 年以后关于测试时自适应的论文」。'),
      tr('agent 会给出论文标题、出处和链接，可以接着让它读某一篇的正文。'),
      tr('值得留下的论文，让它导入文献库，方便之后问答和引用。'),
    ],
    example: tr(
      '「查一下 MedSegDiff 之后在 BraTS 上报告 Dice 的扩散分割方法，按引用数排序，列出数据划分」。',
    ),
    tips: [
      tr('协调者本身不联网，需要检索时会交给线程去做。'),
      tr('界面上没有开关，是否联网由部署方决定。'),
      tr('内网地址不会被读取。'),
    ],
  },
  {
    id: 'library',
    title: tr('文献库'),
    icon: Library,
    to: 'library',
    what: tr(
      '课题组共享的论文库。导入后自动解析出结构、公式、图表和参考文献，可以针对原文问答，回答带页码出处，也能导出 BibTeX。',
    ),
    steps: [
      tr('点「导入论文」，粘贴 arXiv 编号、DOI 或 PDF 链接，或上传 PDF（单个不超过 100 MB）。'),
      tr('解析完打开论文：左边是 PDF，右边有「结构」「问答」「笔记」「BibTeX」。'),
      tr('在「问答」里提问，回答里的出处点一下会跳到 PDF 对应位置。'),
      tr('选中几篇可以导出 BibTeX，或「插入引用」到 LaTeX 文档。'),
    ],
    example: tr(
      '导入 10 篇相关工作后，在问答里打开「在整个文献库里检索」，问「哪些方法在 BraTS 上用了 5 折交叉验证」，逐条核对出处。',
    ),
    tips: [
      tr('agent 也能查文献库、引用里面的论文，线程 agent 和个人 agent 还能帮你导入。'),
      tr('解析服务暂时连不上时会先用逐页纯文本，恢复后可以「重新解析」。'),
    ],
  },
  {
    id: 'notebook',
    title: 'Notebook',
    icon: NotebookTabs,
    to: 'research',
    what: tr(
      '在研究空间可以打开关联的和 Jupyter 一样的 Notebook：写 Python、跑代码、画图，多人实时一起编辑，运行结果同步给所有人。',
    ),
    steps: [
      tr('在研究空间关联 Notebook，点击打开可编辑、运行和导入 .ipynb。'),
      tr('写代码、运行单元格；卡住了可以在「内核」菜单里中断或重启。'),
      tr(
        '在代码里调用 srh.log_metric("acc", 0.9)、srh.log_param(...)，指标和参数保留在单元格输出。',
      ),
    ],
    example: tr(
      '在研究空间关联 Notebook 跑评估脚本，每个 T 记一次 srh.log_metric，核对单元格中的真实输出。',
    ),
    tips: [
      tr('可以导出为 ipynb、HTML、PDF、Markdown 或 .py。'),
      tr('agent 也能读、改、运行 Notebook（线程 agent 和个人 agent）。'),
      tr('服务器没配 Python 内核时只能编辑和查看，不能运行。'),
    ],
  },
  {
    id: 'routines',
    title: tr('定时任务'),
    icon: CalendarClock,
    to: 'settings?tab=routines',
    what: tr('到点自动唤醒协调者或某个线程，执行你写好的指令，适合每天、每周固定要做的事。'),
    steps: [
      tr('在「设置 → 定时任务」点「新建定时任务」。'),
      tr('选时间表（有「工作日 9:00」等预设，也可以写 cron），选目标：协调者或某个线程。'),
      tr('写清到点要做什么，保存后列表里能看到上次和下次运行时间。'),
    ],
    example: tr('每周一 10:00 让协调者整理上周各线程进展，列出卡住的事，组会前就有底了。'),
    tips: [tr('可以「立即运行」试一次，或用开关暂停。'), tr('只有负责人和导师能管理定时任务。')],
  },
];

export interface HelpAdvisorBlock {
  id: string;
  title: string;
  items: string[];
}

export const ADVISOR_GUIDE: HelpAdvisorBlock[] = [
  {
    id: 'advisor-look',
    title: tr('先看什么'),
    items: [
      tr('待我处理：请你审阅的内容、等你拍板的问题都在这里，平时只看这一页就不会漏。'),
      tr('线程：每个线程的进度清单写着做到哪一步、卡在哪里、产出了什么。'),
      tr('研究空间：查看真实运行、固定来源与结论依据。'),
      tr('组会汇报：组会前看学生生成的汇报草稿。'),
    ],
  },
  {
    id: 'advisor-lgtm',
    title: tr('怎么给 LGTM'),
    items: [
      tr('从待我处理或审阅页打开一条审阅。'),
      tr('看内容，需要时逐条评论。'),
      tr('在「你的结论」卡片里点 LGTM；需要改就点「要求修改」，写一句原因。'),
      tr('结论会通知发起人，并回到相关线程。'),
    ],
  },
  {
    id: 'advisor-phone',
    title: tr('在手机上用'),
    items: [
      tr('用手机浏览器打开同一个地址，登录后就能用，不用装 App。'),
      tr(
        '底部标签栏切换协作台、线程、待我处理和审阅，其余页面在「更多」里；切换课题点左上角菜单。',
      ),
      tr('审阅、LGTM、回复消息都能在手机上完成；可以把网址添加到主屏幕，下次一点就开。'),
    ],
  },
];

export interface ShortcutRow {
  /** 每个元素是一个按键；mod 会按平台显示 ⌘ 或 Ctrl */
  keys: string[][];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

/** 只列代码里真实存在的快捷键（lib/shortcuts.ts、Composer、各编辑器）。`mod` = ⌘ / Ctrl，`alt` = ⌥ / Alt */
export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: tr('全局'),
    rows: [
      { keys: [['mod', 'K']], label: tr('打开命令面板：搜索、跳转、常用操作') },
      { keys: [['G'], ['T']], label: tr('回协作台') },
      { keys: [['G'], ['I']], label: tr('打开待我处理') },
      { keys: [['G'], ['W']], label: tr('打开我的工作区') },
      { keys: [['?']], label: tr('打开帮助中心') },
      { keys: [['Esc']], label: tr('关闭浮层、对话框和引导') },
    ],
  },
  {
    title: tr('聊天输入框'),
    rows: [
      { keys: [['Enter']], label: tr('发送') },
      { keys: [['Shift', 'Enter']], label: tr('换行') },
      { keys: [['/']], label: tr('在开头输入，打开斜杠指令菜单（↑ ↓ 选择，Enter 或 Tab 确认）') },
    ],
  },
  {
    title: tr('待我处理'),
    rows: [
      { keys: [['↑'], ['↓']], label: tr('在列表里上下移动') },
      { keys: [['E']], label: tr('标为完成') },
    ],
  },
  {
    title: tr('富文本文档'),
    rows: [
      { keys: [['mod', 'B']], label: tr('粗体') },
      { keys: [['mod', 'I']], label: tr('斜体') },
      { keys: [['mod', 'U']], label: tr('下划线') },
      { keys: [['mod', 'Shift', 'S']], label: tr('删除线') },
      { keys: [['mod', 'Shift', 'H']], label: tr('高亮') },
      { keys: [['mod', 'E']], label: tr('行内代码') },
      { keys: [['mod', 'alt', '1']], label: tr('一级标题（2、3 同理，0 为正文）') },
      { keys: [['mod', 'Shift', '8']], label: tr('无序列表') },
      { keys: [['mod', 'Shift', '7']], label: tr('有序列表') },
      { keys: [['mod', 'Shift', '9']], label: tr('待办列表') },
      { keys: [['mod', 'Shift', 'B']], label: tr('引用') },
      { keys: [['mod', 'alt', 'C']], label: tr('代码块') },
      { keys: [['mod', 'alt', 'M']], label: tr('对选中的文字发评论') },
      { keys: [['mod', 'J']], label: tr('AI 助手（空行里按空格也可以）') },
      { keys: [['mod', 'Z']], label: tr('撤销') },
      { keys: [['mod', 'Shift', 'Z']], label: tr('重做') },
    ],
  },
  {
    title: tr('表格'),
    rows: [
      { keys: [['F2']], label: tr('编辑当前单元格') },
      { keys: [['Enter']], label: tr('确认并下移') },
      { keys: [['Tab']], label: tr('确认并右移') },
      { keys: [['Esc']], label: tr('取消编辑') },
      { keys: [['Delete']], label: tr('清空选中的单元格') },
      { keys: [['mod', tr('方向键')]], label: tr('跳到这一行 / 列的尽头') },
    ],
  },
  {
    title: tr('LaTeX 与幻灯片'),
    rows: [
      { keys: [['mod', 'B']], label: tr('LaTeX：\\textbf{} 加粗') },
      { keys: [['mod', 'I']], label: tr('LaTeX：\\textit{} 斜体') },
      { keys: [['mod', 'S']], label: tr('LaTeX：立即编译') },
      { keys: [['F5']], label: tr('幻灯片：开始放映（也可以 Alt + Enter）') },
    ],
  },
];

export interface FaqItem {
  id: string;
  q: string;
  a: string[];
}

export const FAQ: FaqItem[] = [
  {
    id: 'faq-agent-edits',
    q: tr('agent 会不会乱改我的文档？'),
    a: [
      tr(
        'agent 动手前会先「认领」要改的文档或段落，文档顶部和右侧动态面板里会写明谁正在改哪一部分、为谁改。',
      ),
      tr(
        '如果它要改的地方和你或别人的改动重叠，会出现冲突预警，写清是谁的什么和谁的什么撞了，由你选择「协调」或「忽略」。所有改动都带作者。',
      ),
    ],
  },
  {
    id: 'faq-claims',
    q: tr('认领和冲突预警是什么？'),
    a: [
      tr(
        '认领是“我正在改这里”的登记，成员和 agent 都会留下。冲突预警只在两个认领范围重叠时出现，也会进你的待我处理。',
      ),
      tr('点「协调」会把情况带到协作台，请协调者安排先后；点「忽略」表示你确认两边不会冲突。'),
    ],
  },
  {
    id: 'faq-data',
    q: tr('数据存在哪里？'),
    a: [
      tr(
        '研协部署在你们课题组自己的服务器上，消息、文档、研究空间记录都存在这台服务器的数据库里。',
      ),
      tr(
        'agent 工作时会把需要的上下文发给管理员配置的大模型服务；开启旁聊发出的消息不会发给模型。',
      ),
    ],
  },
  {
    id: 'faq-invite',
    q: tr('怎么邀请导师？'),
    a: [
      tr(
        '负责人或导师在「设置 → 邀请」里生成邀请链接，角色选「导师 / 师兄」；填上对方邮箱，就只有这个邮箱能用这条链接。',
      ),
      tr(
        '把链接发给导师，对方打开后注册或登录就加入了课题。命令面板里搜「邀请成员」也能直接到这一页。',
      ),
    ],
  },
  {
    id: 'faq-guest',
    q: tr('访客能做什么？'),
    a: [
      tr(
        '访客可以查看协作台、线程、文档和研究空间记录，但不能发言、编辑或审阅。需要参与时请负责人把角色改成成员。',
      ),
    ],
  },
];

/** 搜索用：把一个模块的所有文字拼起来 */
export function moduleText(m: HelpModule): string {
  return [m.title, m.what, ...m.steps, m.example, ...m.tips].join(' ');
}

/** 空格分开的每个词都要命中（不区分大小写） */
export function matchesQuery(text: string, query: string): boolean {
  const parts = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return true;
  const hay = text.toLowerCase();
  return parts.every((p) => hay.includes(p));
}
