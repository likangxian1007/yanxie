import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * 落地页的中英双语：一个轻量字典 + React context，不引第三方库。
 * 语言优先级：URL ?lang= > localStorage('srh-lang'，与平台应用共用) > 默认中文。
 * index.html 的内联脚本在首帧前用同样的规则设置 <html lang>、标题与描述，避免闪烁。
 */
export type Lang = 'zh' | 'en';
export const LANG_KEY = 'srh-lang';

const zh = {
  meta: {
    htmlLang: 'zh-CN',
    title: '研协 · 把整个课题组和 AI 放进同一张桌子',
    description:
      '研协是面向科研团队的多人协同 AI Agent 平台：协调者拆解课题、线程并行推进、文档实时协同、审阅 LGTM、组会汇报一键起草，部署在你们自己的服务器上。',
  },
  brand: '研协',
  openApp: '打开研协',
  nav: {
    aria: '主导航',
    homeAria: '研协 首页',
    links: ['工作方式', '功能', '外部 Agent', '手机端'],
    themeAria: '切换亮暗主题',
    toLight: '切换到亮色',
    toDark: '切换到暗色',
    langAria: 'Switch to English',
  },
  people: {
    lin: '林老师',
    linInitial: '林',
    chen: '陈同学',
    chenInitial: '陈',
    zhou: '周同学',
    zhouInitial: '周',
  },
  hero: {
    eyebrow: '为科研团队而生的多人 AI Agent 平台',
    h1a: '把整个课题组，',
    h1b: '和 AI 放进同一张桌子',
    desc: '导师、学生和 Agent 在同一个课题里协作：协调者把需求拆成任务，线程并行推进，文档实时协同，审阅一键 LGTM，组会汇报自动起草——每一步都有依据，每一份进展都看得见。',
    secondary: '看它怎么工作',
  },
  frame: {
    nav: [
      '协作台',
      '我的工作区',
      '文档',
      '方案与依据',
      '研究空间',
      '文献库',
      '任务',
      '组会汇报',
      '待我处理',
    ],
    threads: [
      '文献调研：轻量 Transformer 故障诊断',
      '实验设计与消融：CWRU 轴承数据',
      '对比实验报告初稿',
    ],
    agents: ['调研', '实验', '写作'],
    running: '{a} Agent 正在推进',
    doneReview: '已完成 · 请求审阅',
    queued: '排队中',
    topbar: '轴承故障诊断 · 协作台',
    linRole: '林老师 · 负责人',
    ask: '下周组会前，把轻量 CNN 和 Transformer 在轴承数据上的对比做完，要有消融。',
    coordMeta: '协调者 · 已读取方案 v3 与团队依据',
    coordReply: '拆成 3 个线程并行推进：调研 → 实验与消融 → 报告。报告完成后自动请林老师审阅。',
    decision: '决策卡 · 等你拍板',
    decisionQ: '消融实验要不要包含数据增强？',
    include: '包含',
    exclude: '不包含',
    input: '给协调者发消息，或输入 / 调出指令',
    effort: '强度 · 高',
    threadsPanel: '线程 · 并行中',
  },
  marquee: {
    aria: '能力一览',
    rowA: [
      '协调者拆解',
      '线程并行',
      '文档/表格/幻灯片/LaTeX 实时协同',
      '认领与冲突预警',
      '审阅 LGTM',
      '组会汇报',
      '方案与依据',
      '团队记忆',
      '研究空间',
      '文献库页码出处',
      'Notebook',
    ],
    rowB: [
      '斜杠指令',
      'Skill',
      'MCP',
      '多模型与推理强度',
      '科研 profile',
      '联网学术检索',
      '定时任务',
      '读图',
      '外部 Agent 接入',
      '手机端 LGTM',
      '自托管',
    ],
  },
  story: {
    eyebrow: '工作方式',
    titleA: '一个需求，',
    titleB: '怎么变成整组的进展',
    desc: '从一句话的需求到组会上的汇报，研协把中间每一步都摆在桌面上：谁在做、做到哪、依据是什么。',
    steps: [
      {
        title: '协调者拆解',
        desc: '你只说一句需求，协调者读懂课题背景，把它拆成带负责人、依赖和验收标准的任务。方案和依据一并写清楚，组里每个人都能看懂为什么这样做。',
      },
      {
        title: '线程并行',
        desc: '每个任务开一个线程，成员和 Agent 在线程里并行推进。认领、进度、冲突预警实时同步，不再有人重复劳动或互相踩脚。',
      },
      {
        title: '文档协同',
        desc: '文档、表格、幻灯片、LaTeX 多人实时编辑，Agent 和你写在同一份稿子里。引用直接落到文献库的页码出处，改动有迹可循。',
      },
      {
        title: '审阅 LGTM',
        desc: 'Agent 的产出先进审阅，导师逐条看改动、留评论，满意了一键 LGTM。没有人点头的内容，不会悄悄进入课题。',
      },
      {
        title: '组会汇报',
        desc: '一周的线程、文档和审阅记录，自动汇总成组会汇报草稿：进展、问题、下一步。你只需要再改两句，就能直接上会。',
      },
    ],
  },
  stages: {
    plan: {
      title: '协作台',
      meta: '协调者规划',
      coordinator: '协调者',
      coordDesc: '读取课题记忆，拆成可以并行的线程。',
      memory: ['正式方案 v3', '团队依据 · 12 条', '个人记忆'],
    },
    thread: {
      title: '线程',
      checklist: '进度清单',
      checks: [
        '检索 OpenAlex 与 arXiv',
        '筛出 14 篇轻量模型论文',
        '整理对比表',
        '写综述段落',
        '请求审阅',
      ],
      outputs: '产出',
      files: ['对比表.xlsx', '综述 §2.md', 'refs.bib'],
      alsoRunning: '同时在跑',
    },
    doc: {
      title: '文档',
      meta: '对比实验报告.docx · 3 人在线',
      heading: '2.3 消融实验设计',
      p1a: '我们在 CWRU 数据集上比较轻量 CNN 与轻量 Transformer，',
      p1hl: '输入统一为 2048 点振动片段',
      p1b: '，并逐项移除注意力、数据增强与位置编码。',
      claimed: '写作 Agent 已认领本段',
      typed: '结果表明，移除位置编码后 Transformer 的准确率下降 3.1%',
      typeStep: 4,
      p2a: '表 2 给出各配置在四种故障类型上的',
      p2term: '宏平均 F1',
      p2b: '。',
      conflict: '冲突预警',
      conflictDesc: '陈同学正在改同一段，写作 Agent 会先提交改动提案，等你们 LGTM。',
      mention: '@周同学',
      mentionMsg: '表 2 的数据请对一下最新 run',
    },
    review: {
      title: '审阅',
      meta: '对比实验报告 v3 → 林老师、周同学',
      proposed: '写作 Agent 提交了 4 处改动',
      del: '准确率提升明显。',
      add1: '宏平均 F1 提升 2.4%（5 次随机种子）。',
      ctx: '表 2 · 各配置对比',
      add2: '附：消融的完整运行记录见研究空间。',
      comment: '评论第 2 行：种子数写进表注里吧。',
      verdict: '你的结论',
      linRole: '林老师 · 导师',
      requestChanges: '要求修改',
      allPassed: '已全部通过',
    },
    report: {
      title: '组会汇报',
      meta: '协调者起草',
      range: '10月27日 … 11月2日',
      stats: ['线程 6', '审阅 4', '文档改动 23'],
      heading: '第 9 周组会汇报 · 草稿',
      lines: [
        '本周完成：轻量 CNN / Transformer 对比与 3 组消融。',
        '关键结论：位置编码贡献最大，移除后 F1 下降 3.1%。',
        '已通过审阅：对比实验报告 v3（林老师 LGTM）。',
        '下周计划：在变工况数据上复现，并准备投稿前模拟审稿。',
      ],
    },
  },
  bento: {
    eyebrow: '一个课题需要的，都在这里',
    titleA: '不只是聊天框，',
    titleB: '是整个课题组的工作台',
    desc: '文献、方案、实验、文档、审阅、任务——成员和 Agent 用同一套上下文工作，每一步都有出处，每一次改动都能回滚。',
    library: {
      title: '文献库',
      desc: '导入 arXiv、DOI 或 PDF，解析出结构、公式和图表；提问时答案带页码出处，一键生成 BibTeX、插入 LaTeX 引用。',
      authors: 'Dosovitskiy 等 · 2020 · arXiv:2010.11929',
      question: 'ViT 在小数据集上表现如何？',
      answer: '在 ImageNet 预训练后，ViT-B/16 在中等规模数据上与 ResNet 持平，数据越多优势越明显。',
      answerStep: 14,
      cite: 'p.8 · 表 2',
      chips: ['arXiv', 'DOI', 'PDF', '公式', '图表', '插入 LaTeX 引用'],
    },
    slash: {
      title: '斜杠指令 · Skill · MCP',
      desc: '/goal /plan /skill /model /effort /profile /compact /stop，像用 Claude Code 一样指挥 Agent。',
      items: [
        '设定目标，持续推进到完成',
        '先出计划，再动手',
        '调用团队沉淀的 Skill',
        '切换模型与推理强度',
        '切到科研 profile',
        '压缩上下文',
      ],
    },
    plans: {
      title: '方案与依据',
      desc: '正式方案与探索副本分开；团队依据走提议，全部喂进 Agent 上下文。',
      tabs: ['正式方案', '探索副本'],
      evidenceK: '团队依据',
      evidenceV: '采用 5 折交叉验证',
      proposalK: '提议',
      proposalA: '固定随机种子 3 个',
      proposalB: '改用留一工况验证',
      memoryK: '个人记忆',
      memoryV: '我偏好 PyTorch Lightning',
    },
    inbox: {
      title: '待我处理',
      desc: '要你审阅、等你拍板、@ 你的，都汇到这一页。',
      items: [
        ['审阅', '对比实验报告 v3'],
        ['拍板', '消融是否含数据增强'],
        ['@你', '表 2 的数据请对一下'],
      ],
    },
    research: {
      title: '研究空间',
      desc: '把材料、证据、结论和真实运行摆在一张画布上，结论能追到依据。',
      nodes: ['材料 · CWRU 数据', '证据 · 表 2', '运行 · ablation-07', '结论 · 位置编码最关键'],
    },
    notebook: { title: 'Notebook', desc: '类 Jupyter，多人实时一起跑。' },
    tasks: {
      title: '任务',
      desc: '看板与待办，人和 Agent 都在上面。',
      cols: ['待办', '进行中', '完成'],
      todo: '复现基线',
      moving: '消融 · 位置编码',
      done: '数据清洗',
    },
    profile: {
      title: '科研 profile · 联网与学术检索',
      desc: '文献调研与综述、实验设计与消融、投稿前模拟审稿；检索 OpenAlex、Semantic Scholar、Crossref、arXiv，还能读图、跑定时任务。',
      profiles: ['文献调研与综述', '实验设计与消融', '投稿前模拟审稿'],
      scheduled: '定时任务',
      models: '多家模型 · 推理强度',
    },
    share: {
      title: '个人空间 · 团队空间',
      desc: '链接分享可阅读、可评论、可编辑；负责人、导师、成员、访客各有权限。',
      levels: ['可阅读', '可评论', '可编辑'],
      roles: ['负责人', '导师', '成员', '访客'],
    },
    version: {
      title: '版本历史',
      desc: '每次改动可对比、可回滚；Agent 的改动走提案，LGTM 后才落地。',
      items: ['v12 · 写作 Agent 改动提案', 'v11 · 周同学', 'v10 · 林老师', 'v9 · 导入 docx'],
      restore: '回滚',
    },
  },
  agents: {
    eyebrow: '外部 Agent',
    titleA: '你自己的 Agent，',
    titleB: '也能进课题',
    desc: 'Claude Code、Codex 这些你每天在用的个人 Agent，用一枚 API 令牌、通过入站 MCP 接进研协，和组里的成员、Agent 坐在同一张桌子上。',
    termAria: '外部 Agent 接入配置示例',
    termComment1: '# 在研协「设置 → API 令牌」新建一个令牌，然后：',
    termComment2: '# 或写进任意 MCP 客户端的配置（Codex 等）',
    termDone: '✓ 已连接研协 · 可用工具：课题、线程、文档、审阅…',
    points: [
      {
        title: '权限跟随你的角色',
        desc: '令牌代表你本人：你在课题里能看、能改什么，你的 Agent 就只能看、只能改什么。',
      },
      {
        title: '令牌可随时吊销',
        desc: '每个令牌单独命名、单独吊销。换电脑、离组、用完即弃，一键收回。',
      },
      {
        title: '读写课题内容、文档、线程',
        desc: '你的 Agent 能读课题背景、在线程里汇报进展、编辑文档、发起审阅，和组里的 Agent 一起干活。',
      },
    ],
  },
  mobile: {
    eyebrow: '手机端',
    titleA: '导师在手机上，',
    titleB: '也能一键 LGTM',
    desc: '课题不会只在工位上推进。研协的手机端把需要你的事集中起来，看一眼、点一下，进展就不会卡在你这里。',
    points: [
      {
        title: '不用装 App',
        desc: '手机浏览器打开就是适配好的移动界面，添加到主屏幕即可像 App 一样使用。',
      },
      {
        title: '待我处理集中提醒',
        desc: '要你审阅的改动、等你拍板的决策卡、@你的消息，都汇总在一处，不会漏掉。',
      },
      {
        title: '回复、审阅、拍板都能在手机上完成',
        desc: '看完改动直接 LGTM，或者留一句评论让 Agent 再改一版，组会路上就把事办完。',
      },
    ],
    phoneMeta: '审阅 · 对比实验报告 v3',
    phoneTitle: '写作 Agent 提交了 4 处改动',
    phoneSeen: '周同学 已看过 · 等你确认',
    diff: [
      '## 3. 实验结果',
      '准确率提升明显。',
      '宏平均 F1 提升 2.4%（5 次随机种子）。',
      '附：消融运行记录见研究空间。',
      '表 2 · 各配置对比',
    ],
    comment: '：种子数写进表注里，其他没问题。',
    approved: '已 LGTM',
    tabs: ['协作台', '线程', '待我处理', '审阅', '更多'],
  },
  selfhost: {
    eyebrow: '自托管',
    titleA: '部署在',
    titleB: '你们自己的服务器上',
    desc: '研协是给课题组自己掌控的工具：数据、模型、权限都由你们决定。',
    cards: [
      {
        title: '数据留在课题组',
        desc: '消息、文档、研究记录存在你们自己的数据库里，不经过任何第三方平台。',
      },
      {
        title: 'Docker Compose 一键部署',
        desc: '一台服务器、一条命令就能跑起来，升级同样只需拉取新镜像重启。',
      },
      {
        title: '接入你选的模型',
        desc: '任何 OpenAI 兼容接口、DeepSeek 等都能接，按任务选择模型与推理强度。',
      },
      {
        title: '角色与权限',
        desc: '负责人、导师、成员、访客各有边界，谁能看、谁能改、谁能拍板，一清二楚。',
      },
    ],
    rolesCode: '负责人 · 导师 · 成员 · 访客',
    shots: [
      { caption: '文档协同', path: '文档 / 对比实验报告' },
      { caption: '线程进度', path: '线程 / 文献调研' },
      { caption: '审阅', path: '审阅 / 报告 v3' },
      { caption: '文献库', path: '文献库' },
    ],
    shotAlt: '研协真实界面：{c}',
    realTitle: '真实界面',
    realDesc: '以下都是研协的实际截图，不是概念稿。',
  },
  cta: {
    aria: '开始使用',
    secondary: '先看看它怎么工作',
    note: 'co.thinkloft.io · 可自托管 · 数据留在课题组',
    titleA: '今天就把课题',
    titleB: '搬进研协',
    desc: '建一个课题，邀请导师和同学，把第一句需求交给协调者。剩下的，你会在线程里看到。',
  },
  footer: {
    topAria: '回到顶部',
    navAria: '页脚导航',
    links: ['工作方式', '功能', '外部 Agent', '手机端', '自托管'],
    copyright: '© {y} 研协 · thinkloft',
  },
};

export type Dict = typeof zh;

const en: Dict = {
  meta: {
    htmlLang: 'en',
    title: 'Thinkloft · Your whole lab and AI, at one table',
    description:
      'Thinkloft is the multiplayer AI agent platform for research teams: the Coordinator breaks down projects, Threads run in parallel, docs sync live, Reviews close with an LGTM, and group meeting reports draft themselves — all on your own servers.',
  },
  brand: 'Thinkloft',
  openApp: 'Open Thinkloft',
  nav: {
    aria: 'Main navigation',
    homeAria: 'Thinkloft home',
    links: ['How it works', 'Features', 'Agents', 'Mobile'],
    themeAria: 'Toggle light and dark theme',
    toLight: 'Switch to light',
    toDark: 'Switch to dark',
    langAria: 'Switch to Chinese',
  },
  people: {
    lin: 'Prof. Lin',
    linInitial: 'L',
    chen: 'Chen',
    chenInitial: 'C',
    zhou: 'Zhou',
    zhouInitial: 'Z',
  },
  hero: {
    eyebrow: 'The multiplayer AI agent platform for research teams',
    h1a: 'Your whole lab, ',
    h1b: 'and AI, at one table',
    desc: 'Advisors, students, and agents in one shared project. The Coordinator turns requests into tasks, Threads run in parallel, docs sync live, Reviews close with one LGTM, and group meeting reports draft themselves — every step grounded in evidence, every bit of progress in plain sight.',
    secondary: 'See how it works',
  },
  frame: {
    nav: [
      'Hub',
      'My workspace',
      'Docs',
      'Plans & Evidence',
      'Research Space',
      'Library',
      'Tasks',
      'Meeting reports',
      'Inbox',
    ],
    threads: [
      'Literature review: lightweight Transformers for fault diagnosis',
      'Experiment design & ablation: CWRU bearing data',
      'Comparison report, first draft',
    ],
    agents: ['Research', 'Experiment', 'Writing'],
    running: '{a} agent at work',
    doneReview: 'Done · Review requested',
    queued: 'Queued',
    topbar: 'Bearing fault diagnosis · Hub',
    linRole: 'Prof. Lin · Owner',
    ask: 'Before next week’s group meeting, finish the lightweight CNN vs. Transformer comparison on the bearing data — with ablations.',
    coordMeta: 'Coordinator · read plan v3 and team evidence',
    coordReply:
      'Splitting this into 3 parallel Threads: research → experiments & ablation → report. Prof. Lin gets a Review request once the report is ready.',
    decision: 'Decision · needs your call',
    decisionQ: 'Include data augmentation in the ablation?',
    include: 'Include',
    exclude: 'Exclude',
    input: 'Message the Coordinator, or type / for commands',
    effort: 'Effort · High',
    threadsPanel: 'Threads · in parallel',
  },
  marquee: {
    aria: 'Capabilities at a glance',
    rowA: [
      'Coordinator planning',
      'Parallel Threads',
      'Live docs, sheets, slides & LaTeX',
      'Claims & conflict alerts',
      'Review & LGTM',
      'Group meeting reports',
      'Plans & Evidence',
      'Team memory',
      'Research Space',
      'Page-level Library citations',
      'Notebook',
    ],
    rowB: [
      'Slash commands',
      'Skills',
      'MCP',
      'Multi-model & reasoning effort',
      'Research profiles',
      'Web & scholarly search',
      'Scheduled tasks',
      'Image understanding',
      'External agents',
      'LGTM on mobile',
      'Self-hosted',
    ],
  },
  story: {
    eyebrow: 'How it works',
    titleA: 'One request, ',
    titleB: 'the whole lab moving',
    desc: 'From a one-line request to the group meeting report, Thinkloft puts every step in between on the table: who’s on it, how far it’s come, and why.',
    steps: [
      {
        title: 'The Coordinator plans',
        desc: 'Say it in one sentence. The Coordinator reads the project context and breaks it into tasks with owners, dependencies, and acceptance criteria — plans and evidence spelled out, so everyone sees the why.',
      },
      {
        title: 'Threads run in parallel',
        desc: 'Every task gets its own Thread, where members and agents push forward side by side. Claims, progress, and conflict alerts sync live — no duplicated work, no stepped-on toes.',
      },
      {
        title: 'Docs, written together',
        desc: 'Docs, sheets, slides, and LaTeX, edited live by the whole team — agents write in the same draft you do. Citations point to exact pages in the Library, and every change leaves a trail.',
      },
      {
        title: 'Review & LGTM',
        desc: 'Agent output lands in Review first. Advisors walk through each change, comment inline, and LGTM in one click. Nothing slips into the project without a nod.',
      },
      {
        title: 'Group meeting report',
        desc: 'A week of Threads, docs, and Reviews, rolled into a group meeting report draft: progress, blockers, next steps. Tweak a line or two and you’re ready to present.',
      },
    ],
  },
  stages: {
    plan: {
      title: 'Hub',
      meta: 'Coordinator planning',
      coordinator: 'Coordinator',
      coordDesc: 'Reads project memory and splits the work into parallel Threads.',
      memory: ['Official plan v3', 'Team evidence · 12', 'Personal memory'],
    },
    thread: {
      title: 'Thread',
      checklist: 'Checklist',
      checks: [
        'Search OpenAlex and arXiv',
        'Shortlist 14 lightweight-model papers',
        'Build the comparison table',
        'Draft the review section',
        'Request Review',
      ],
      outputs: 'Outputs',
      files: ['comparison.xlsx', 'review-s2.md', 'refs.bib'],
      alsoRunning: 'Also running',
    },
    doc: {
      title: 'Doc',
      meta: 'comparison-report.docx · 3 online',
      heading: '2.3 Ablation design',
      p1a: 'We compare a lightweight CNN and a lightweight Transformer on CWRU, ',
      p1hl: 'with inputs fixed to 2,048-point vibration segments',
      p1b: ', removing attention, augmentation, and positional encoding one at a time.',
      claimed: 'Writing agent claimed this paragraph',
      typed: 'Removing positional encoding cuts Transformer accuracy by 3.1%',
      typeStep: 8,
      p2a: 'Table 2 reports ',
      p2term: 'macro F1',
      p2b: ' for each configuration across four fault types.',
      conflict: 'Conflict alert',
      conflictDesc:
        'Chen is editing the same paragraph. The Writing agent will submit a proposal and wait for your LGTM.',
      mention: '@Zhou',
      mentionMsg: 'can you check Table 2 against the latest run?',
    },
    review: {
      title: 'Review',
      meta: 'Comparison report v3 → Prof. Lin, Zhou',
      proposed: 'Writing agent proposed 4 changes',
      del: 'Accuracy improved significantly.',
      add1: 'Macro F1 up 2.4% (5 random seeds).',
      ctx: 'Table 2 · Configuration comparison',
      add2: 'Full ablation run logs are in the Research Space.',
      comment: 'on line 2: add the seed count to the table note.',
      verdict: 'Your verdict',
      linRole: 'Prof. Lin · Advisor',
      requestChanges: 'Request changes',
      allPassed: 'ALL APPROVED',
    },
    report: {
      title: 'Group meeting report',
      meta: 'Drafted by the Coordinator',
      range: 'Oct 27 – Nov 2',
      stats: ['6 Threads', '4 Reviews', '23 doc edits'],
      heading: 'Week 9 group meeting report · Draft',
      lines: [
        'Shipped this week: lightweight CNN vs. Transformer comparison, plus 3 ablations.',
        'Key finding: positional encoding matters most — removing it drops F1 by 3.1%.',
        'Passed Review: comparison report v3 (LGTM from Prof. Lin).',
        'Next week: reproduce under varying conditions and run a pre-submission mock review.',
      ],
    },
  },
  bento: {
    eyebrow: 'Everything a project needs',
    titleA: 'Not just a chat box — ',
    titleB: 'your whole lab’s workbench',
    desc: 'Literature, plans, experiments, docs, reviews, tasks — members and agents share one context. Every step is sourced; every change can be rolled back.',
    library: {
      title: 'Library',
      desc: 'Import from arXiv, DOI, or PDF and get structure, equations, and figures parsed. Answers cite the exact page, with one-click BibTeX and LaTeX citations.',
      authors: 'Dosovitskiy et al. · 2020 · arXiv:2010.11929',
      question: 'How does ViT do on small datasets?',
      answer:
        'Pretrained on ImageNet, ViT-B/16 matches ResNet on mid-sized data — and pulls further ahead as data grows.',
      answerStep: 24,
      cite: 'p.8 · Table 2',
      chips: ['arXiv', 'DOI', 'PDF', 'Equations', 'Figures', 'Insert LaTeX cite'],
    },
    slash: {
      title: 'Slash commands · Skills · MCP',
      desc: '/goal /plan /skill /model /effort /profile /compact /stop — direct your agents the way you would in Claude Code.',
      items: [
        'Set a goal, keep going until done',
        'Plan first, then act',
        'Run a Skill your team built',
        'Switch model and reasoning effort',
        'Switch to a research profile',
        'Compact the context',
      ],
    },
    plans: {
      title: 'Plans & Evidence',
      desc: 'Official plans stay apart from exploratory copies. Team evidence changes by proposal — and all of it feeds the agents’ context.',
      tabs: ['Official plan', 'Exploration'],
      evidenceK: 'Team evidence',
      evidenceV: '5-fold cross-validation',
      proposalK: 'Proposal',
      proposalA: 'Fix 3 random seeds',
      proposalB: 'Leave-one-condition-out instead',
      memoryK: 'Personal memory',
      memoryV: 'I prefer PyTorch Lightning',
    },
    inbox: {
      title: 'Inbox',
      desc: 'Reviews waiting on you, calls only you can make, and every @mention — on one page.',
      items: [
        ['Review', 'Comparison report v3'],
        ['Decide', 'Augmentation in the ablation?'],
        ['@you', 'Please double-check Table 2'],
      ],
    },
    research: {
      title: 'Research Space',
      desc: 'Lay out materials, evidence, conclusions, and real runs on one canvas — every conclusion traces back to its evidence.',
      nodes: [
        'Material · CWRU data',
        'Evidence · Table 2',
        'Run · ablation-07',
        'Finding · PE is key',
      ],
    },
    notebook: { title: 'Notebook', desc: 'Jupyter-style, run live with your team.' },
    tasks: {
      title: 'Tasks',
      desc: 'Board and To-dos, shared by people and agents.',
      cols: ['To-do', 'Doing', 'Done'],
      todo: 'Reproduce baseline',
      moving: 'Ablation · pos. encoding',
      done: 'Data cleaning',
    },
    profile: {
      title: 'Research profiles · Web & scholarly search',
      desc: 'Literature reviews, experiment design and ablation, pre-submission mock review. Search OpenAlex, Semantic Scholar, Crossref, and arXiv — plus image understanding and scheduled tasks.',
      profiles: ['Literature review', 'Experiments & ablation', 'Mock peer review'],
      scheduled: 'Scheduled tasks',
      models: 'Multi-model · effort',
    },
    share: {
      title: 'Personal & team spaces',
      desc: 'Share links as view, comment, or edit. Owner, Advisor, Member, and Guest each get the right access.',
      levels: ['View', 'Comment', 'Edit'],
      roles: ['Owner', 'Advisor', 'Member', 'Guest'],
    },
    version: {
      title: 'Version history',
      desc: 'Diff and roll back any change. Agent edits arrive as proposals and land only after an LGTM.',
      items: [
        'v12 · Writing agent proposal',
        'v11 · Zhou',
        'v10 · Prof. Lin',
        'v9 · Imported .docx',
      ],
      restore: 'Restore',
    },
  },
  agents: {
    eyebrow: 'External agents',
    titleA: 'Your own agents, ',
    titleB: 'in the project too',
    desc: 'Claude Code, Codex — the personal agents you already use every day — connect to Thinkloft over inbound MCP with a single API token, and take a seat at the same table as your lab.',
    termAria: 'External agent setup example',
    termComment1: '# Create a token in Thinkloft under Settings → API tokens, then:',
    termComment2: '# Or add it to any MCP client config (Codex, etc.)',
    termDone: '✓ Connected to Thinkloft · tools: projects, threads, docs, reviews…',
    points: [
      {
        title: 'Permissions follow your role',
        desc: 'A token acts as you: your agent can see and change exactly what you can in the project — nothing more.',
      },
      {
        title: 'Revoke tokens anytime',
        desc: 'Name and revoke each token on its own. New laptop, leaving the lab, or a one-off job — pull it back in one click.',
      },
      {
        title: 'Read and write projects, docs, and Threads',
        desc: 'Your agent can read project context, report progress in Threads, edit docs, and open Reviews — working right alongside your lab’s agents.',
      },
    ],
  },
  mobile: {
    eyebrow: 'Mobile',
    titleA: 'Advisors on the go, ',
    titleB: 'LGTM in one tap',
    desc: 'Research doesn’t only move at the desk. On mobile, Thinkloft gathers everything that needs you — one glance, one tap, and progress never stalls on your end.',
    points: [
      {
        title: 'No app to install',
        desc: 'Open it in your phone’s browser for a mobile-tuned interface. Add it to your home screen and it feels just like an app.',
      },
      {
        title: 'One Inbox for everything',
        desc: 'Changes awaiting your Review, decision cards awaiting your call, and @mentions all land in one place. Nothing slips through.',
      },
      {
        title: 'Reply, review, and decide on your phone',
        desc: 'LGTM right after reading the changes, or leave a comment for the agent to revise — handled before you reach the meeting.',
      },
    ],
    phoneMeta: 'Review · Comparison report v3',
    phoneTitle: 'Writing agent proposed 4 changes',
    phoneSeen: 'Zhou reviewed · waiting on you',
    diff: [
      '## 3. Results',
      'Accuracy improved significantly.',
      'Macro F1 up 2.4% (5 random seeds).',
      'Ablation run logs: see Research Space.',
      'Table 2 · Configuration comparison',
    ],
    comment: ': Put the seed count in the table note. Everything else looks good.',
    approved: 'Approved',
    tabs: ['Hub', 'Threads', 'Inbox', 'Review', 'More'],
  },
  selfhost: {
    eyebrow: 'Self-hosted',
    titleA: 'Runs on ',
    titleB: 'your own servers',
    desc: 'Thinkloft is a tool your lab controls: data, models, and permissions are all your call.',
    cards: [
      {
        title: 'Your data stays in the lab',
        desc: 'Messages, docs, and research records live in your own database — never routed through a third party.',
      },
      {
        title: 'One-command Docker Compose',
        desc: 'One server, one command, and you’re running. Upgrades are just a pull and a restart.',
      },
      {
        title: 'Bring your own models',
        desc: 'Any OpenAI-compatible API, DeepSeek, and more. Choose the model and reasoning effort per task.',
      },
      {
        title: 'Roles & permissions',
        desc: 'Owner, Advisor, Member, Guest — clear lines on who can view, who can edit, and who makes the call.',
      },
    ],
    rolesCode: 'Owner · Advisor · Member · Guest',
    shots: [
      { caption: 'Live docs', path: 'Docs / Comparison report' },
      { caption: 'Thread progress', path: 'Threads / Literature review' },
      { caption: 'Review', path: 'Review / Report v3' },
      { caption: 'Library', path: 'Library' },
    ],
    shotAlt: 'Thinkloft product screenshot: {c}',
    realTitle: 'The real product',
    realDesc: 'Every screenshot below is the shipping product — no concept art.',
  },
  cta: {
    aria: 'Get started',
    secondary: 'See how it works first',
    note: 'co.thinkloft.io · Self-hostable · Your data stays with your lab',
    titleA: 'Bring your project ',
    titleB: 'into Thinkloft today',
    desc: 'Create a project, invite your advisor and labmates, and hand your first request to the Coordinator. You’ll watch the rest unfold in Threads.',
  },
  footer: {
    topAria: 'Back to top',
    navAria: 'Footer navigation',
    links: ['How it works', 'Features', 'Agents', 'Mobile', 'Self-hosting'],
    copyright: '© {y} Thinkloft',
  },
};

export const DICTS: Record<Lang, Dict> = { zh, en };

/** 语言切换按钮上显示的目标语言（自称）。中文模式显示 EN；英文模式显示「中」，这是英文模式下唯一刻意保留的汉字。 */
export const LANG_SWITCH_LABEL: Record<Lang, string> = { zh: 'EN', en: '中' };

function isLang(v: unknown): v is Lang {
  return v === 'zh' || v === 'en';
}

export function detectLang(): Lang {
  if (typeof window === 'undefined') return 'zh';
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (isLang(q)) return q;
  } catch {
    // ignore
  }
  try {
    const s = localStorage.getItem(LANG_KEY);
    if (isLang(s)) return s;
  } catch {
    // 隐私模式等不可读
  }
  return 'zh';
}

function applyDocumentMeta(d: Dict) {
  document.documentElement.lang = d.meta.htmlLang;
  document.title = d.meta.title;
  const set = (sel: string, v: string) => document.querySelector(sel)?.setAttribute('content', v);
  set('meta[name="description"]', d.meta.description);
  set('meta[property="og:title"]', d.meta.title);
  set('meta[property="og:description"]', d.meta.description);
}

interface LangCtx {
  lang: Lang;
  t: Dict;
  setLang: (l: Lang) => void;
}

const Ctx = createContext<LangCtx>({ lang: 'zh', t: zh, setLang: () => {} });

export function LangProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => initial ?? detectLang());

  useEffect(() => {
    applyDocumentMeta(DICTS[lang]);
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      // 不可写时只在本次会话生效
    }
    // 用户主动切换后去掉 ?lang=，避免刷新又被 URL 覆盖
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('lang')) {
        url.searchParams.delete('lang');
        window.history.replaceState(null, '', url.toString());
      }
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo(() => ({ lang, t: DICTS[lang], setLang }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang() {
  return useContext(Ctx);
}

/** 简单占位替换：fmt('{a} agent', { a: 'Research' }) */
export function fmt(s: string, vars: Record<string, string>) {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}
