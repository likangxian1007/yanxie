import type { DocumentKind } from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * 新建文档的模板。`markdown` 原样作为 POST P/docs 的初始内容：
 * - doc：markdown 正文
 * - sheet：markdown 表格（第一行为表头）
 * - slides：以 `## 标题` 分页的 markdown
 * - latex：LaTeX 源码
 */
export interface DocTemplate {
  id: string;
  kind: DocumentKind;
  /** 模板名，也是用模板新建时的文档标题（空白模板除外） */
  title: string;
  description: string;
  markdown: string;
  /** 空白模板：新建出的文档标题用“未命名…” */
  blank?: boolean;
}

/** 空白新建时的默认标题 */
export const UNTITLED_TITLE: Record<DocumentKind, string> = {
  doc: tr('未命名文档'),
  sheet: tr('未命名表格'),
  slides: tr('未命名幻灯片'),
  latex: tr('未命名论文'),
};

/** 用模板新建时的文档标题 */
export function templateDocTitle(t: DocTemplate): string {
  return t.blank ? UNTITLED_TITLE[t.kind] : t.title;
}

// ---------------------------------------------------------------- 文档

const WEEKLY = tr(
  '> 第 __ 周（MM.DD – MM.DD）· 填写人：__ · 课题：__\n\n## 本周进展\n\n- 完成了：\n- 进行中：\n- 阅读了：\n\n## 实验结果\n\n| 实验 | 设置 | 关键指标 | 结论 |\n| --- | --- | --- | --- |\n| EXP-001 基线 | ResNet-50 / CIFAR-10 / lr 0.1 | acc 95.4% | 作为对照 |\n| EXP-002 | 加入数据增强 | acc 96.1% | 增强有效，+0.7 |\n\n## 遇到的问题\n\n1. 问题描述：\n   - 已尝试：\n   - 需要讨论：\n\n## 下周计划\n\n- \n- \n\n## 需要的支持\n\n- 算力 / 数据 / 讨论时间：\n',
);

const READING_NOTES = tr(
  '## 基本信息\n\n- **标题**：\n- **作者**：\n- **发表**：会议 / 期刊，年份\n- **链接**：论文 · 代码\n- **标签**：\n\n## 一句话总结\n\n> 这篇论文用 __ 方法解决了 __ 问题，在 __ 上比 __ 提升了 __。\n\n## 研究问题与动机\n\n- 要解决什么问题？为什么重要？\n- 现有方法的不足：\n\n## 方法\n\n- 核心思想：\n- 关键公式 / 模块：\n- 与已有方法的区别：\n\n## 实验\n\n- 数据集与评价指标：\n- 主要结果：\n- 消融实验说明了什么：\n\n## 优点\n\n- \n\n## 局限与疑问\n\n- \n\n## 对我们工作的启发\n\n- 可以借鉴的点：\n- 可以作为对比的基线：\n\n## 相关文献\n\n- \n',
);

const PROPOSAL = tr(
  '## 一、研究背景与意义\n\n简述研究领域现状、要解决的问题以及其理论与应用价值。\n\n## 二、国内外研究现状\n\n1. 方向一：代表性工作与不足\n2. 方向二：代表性工作与不足\n3. 小结：现有研究尚未解决的关键问题\n\n## 三、研究目标\n\n- 总体目标：\n- 具体目标：\n\n## 四、研究内容\n\n1. 研究内容一：\n2. 研究内容二：\n3. 研究内容三：\n\n## 五、技术路线与研究方法\n\n- 数据：\n- 模型与方法：\n- 评价方案：\n\n## 六、创新点\n\n1. \n2. \n\n## 七、进度安排\n\n| 时间 | 工作内容 | 预期产出 |\n| --- | --- | --- |\n| 第 1–2 月 | 文献调研、确定技术路线 | 调研报告 |\n| 第 3–5 月 | 方法实现与初步实验 | 原型系统、实验记录 |\n| 第 6–8 月 | 完善实验、消融分析 | 完整实验结果 |\n| 第 9–10 月 | 论文撰写与投稿 | 论文初稿 |\n\n## 八、预期成果\n\n- 学术论文：\n- 软件 / 数据集：\n\n## 九、参考文献\n\n1. \n',
);

const MINUTES = tr(
  '## 会议信息\n\n- **时间**：2026 年 MM 月 DD 日 HH:MM\n- **地点**：线上 / 会议室\n- **主持**：\n- **记录**：\n- **参会**：\n\n## 议程\n\n1. 上次行动项回顾\n2. 各自进展汇报\n3. 问题讨论\n\n## 讨论要点\n\n### 议题一\n\n- 观点：\n- 结论：\n\n### 议题二\n\n- 观点：\n- 结论：\n\n## 决议\n\n- \n\n## 行动项\n\n| 事项 | 负责人 | 截止日期 | 状态 |\n| --- | --- | --- | --- |\n|  |  |  | 未开始 |\n\n## 下次会议\n\n- 时间：\n- 待议：\n',
);

// ---------------------------------------------------------------- 表格

const EXPERIMENT_SHEET = tr(
  '| 实验编号 | 日期 | 模型 | 数据集 | 学习率 | batch | epoch | acc | loss | 备注 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| EXP-001 | 2026-10-20 | ResNet-50 | CIFAR-10 | 0.1 | 128 | 200 | 0.954 | 0.162 | 基线，SGD + cosine |\n| EXP-002 | 2026-10-22 | ViT-S/16 | CIFAR-10 | 0.0003 | 256 | 300 | 0.968 | 0.121 | AdamW，warmup 10 轮 |\n| EXP-003 | 2026-10-24 | ResNet-50 | CIFAR-100 | 0.1 | 128 | 200 | 0.781 | 0.874 | 与 EXP-001 同设置 |\n',
);

const LITERATURE_SHEET = tr(
  '| 标题 | 作者 | 年份 | 会议/期刊 | 链接 | 主题 | 阅读状态 | 相关度 | 负责人 | 笔记 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| Attention Is All You Need | Vaswani et al. | 2017 | NeurIPS | https://arxiv.org/abs/1706.03762 | Transformer | 已读 | 5 |  | 自注意力基础 |\n| Denoising Diffusion Probabilistic Models | Ho et al. | 2020 | NeurIPS | https://arxiv.org/abs/2006.11239 | 扩散模型 | 在读 | 4 |  | 关注噪声调度 |\n| Segment Anything | Kirillov et al. | 2023 | ICCV | https://arxiv.org/abs/2304.02643 | 分割 | 未读 | 3 |  | 可作对比基线 |\n',
);

// ---------------------------------------------------------------- 幻灯片

const GROUP_MEETING_SLIDES = tr(
  '## 组会汇报：课题名称\n\n汇报人：__\n日期：2026 年 MM 月 DD 日\n\n## 本周进展\n\n- 完成：基线复现，与论文结果误差 < 0.5%\n- 进行中：新模块的消融实验\n- 阅读：2 篇相关论文（见文献追踪表）\n\n## 实验结果\n\n| 方法 | acc | loss |\n| --- | --- | --- |\n| 基线 | 95.4% | 0.162 |\n| 本方法 | 96.8% | 0.121 |\n\n- 结论：提升主要来自 __\n- 下一步需要验证 __\n\n## 问题与讨论\n\n- 问题 1：训练后期 loss 震荡，怀疑学习率过大\n- 问题 2：数据集划分是否与论文一致？\n- 希望老师 / 同学给建议的地方：\n\n## 下周计划\n\n- 完成消融实验（3 组）\n- 在 CIFAR-100 上验证泛化性\n- 整理实验记录，开始写方法部分\n\n## Q&A\n\n谢谢，欢迎提问与讨论\n',
);

const PAPER_SHARING_SLIDES = tr(
  '## 论文分享：论文标题\n\n分享人：__\n论文：作者，会议 年份\n\n## 背景与动机\n\n- 研究问题：\n- 为什么重要：\n- 现有方法的不足：\n\n## 核心方法\n\n- 关键想法：\n- 模型结构 / 算法流程：\n- 与已有方法的区别：\n\n## 实验结果\n\n- 数据集与指标：\n- 主要结果：\n- 消融实验：\n\n## 优点与局限\n\n- 优点：\n- 局限：\n- 疑问：\n\n## 对我们的启发\n\n- 可以借鉴：\n- 可以对比：\n- 讨论问题：\n',
);

// ---------------------------------------------------------------- LaTeX

const ARTICLE_LATEX_HEADER = tr(
  '% 学术论文模板（pdfLaTeX 可直接编译）\n% 结构：摘要 → 引言 → 相关工作 → 方法 → 实验 → 结论 → 参考文献\n',
);
const ARTICLE_LATEX =
  ARTICLE_LATEX_HEADER +
  String.raw`\documentclass[11pt]{article}

\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[margin=1in]{geometry}
\usepackage{hyperref}

\title{Your Paper Title}
\author{First Author\thanks{Department, University. \texttt{first@example.edu}} \and Second Author}
\date{\today}

\begin{document}

\maketitle

\begin{abstract}
We study the problem of \emph{...}. Existing approaches suffer from \emph{...}.
We propose a simple yet effective method that \emph{...}.
Experiments on standard benchmarks show that our method improves accuracy by
1.4 points over a strong baseline while adding less than 2\% parameters.
\end{abstract}

\section{Introduction}
\label{sec:intro}
Deep neural networks have achieved remarkable success in many tasks
\cite{vaswani2017attention}. However, ... In this paper, we make the following
contributions:
\begin{itemize}
  \item We identify ...
  \item We propose ...
  \item We demonstrate ...
\end{itemize}

\section{Related Work}
\label{sec:related}
\paragraph{Attention models.} Self-attention \cite{vaswani2017attention} ...
\paragraph{Generative models.} Diffusion models \cite{ho2020denoising} ...

\section{Method}
\label{sec:method}

\subsection{Problem Formulation}
Given a training set $\mathcal{D} = \{(x_i, y_i)\}_{i=1}^{N}$, we learn a model
$f_\theta$ by minimizing the regularized empirical risk
\begin{equation}
  \mathcal{L}(\theta) = \frac{1}{N} \sum_{i=1}^{N} \ell\bigl(f_\theta(x_i), y_i\bigr)
  + \lambda \lVert \theta \rVert_2^2 ,
  \label{eq:loss}
\end{equation}
where $\lambda > 0$ controls the strength of regularization.

\subsection{Optimization}
We optimize Eq.~\eqref{eq:loss} with stochastic gradient descent:
\begin{align}
  g_t      &= \nabla_\theta \mathcal{L}(\theta_{t-1}), \\
  \theta_t &= \theta_{t-1} - \eta_t \, g_t ,
\end{align}
where $\eta_t$ follows a cosine schedule.

\section{Experiments}
\label{sec:exp}
We evaluate on CIFAR-10 and report the mean over three random seeds.
Table~\ref{tab:main} summarizes the main results.

\begin{table}[t]
  \centering
  \caption{Main results on CIFAR-10 (mean of 3 seeds).}
  \label{tab:main}
  \begin{tabular}{lccc}
    \hline
    Method   & Params (M) & Acc. (\%)      & Loss           \\
    \hline
    Baseline & 25.6       & 95.4           & 0.162          \\
    Ours     & 25.9       & \textbf{96.8}  & \textbf{0.121} \\
    \hline
  \end{tabular}
\end{table}

\section{Conclusion}
\label{sec:conclusion}
We presented ... Future work includes ...

\begin{thebibliography}{9}
\bibitem{vaswani2017attention}
A.~Vaswani, N.~Shazeer, N.~Parmar, J.~Uszkoreit, L.~Jones, A.~N. Gomez,
{\L}.~Kaiser, and I.~Polosukhin.
\newblock Attention is all you need.
\newblock In \emph{Advances in Neural Information Processing Systems}, 2017.

\bibitem{ho2020denoising}
J.~Ho, A.~Jain, and P.~Abbeel.
\newblock Denoising diffusion probabilistic models.
\newblock In \emph{Advances in Neural Information Processing Systems}, 2020.
\end{thebibliography}

\end{document}
`;

const CTEX_LATEX = String.raw`% 中文论文模板（请用 XeLaTeX 编译）
\documentclass[UTF8,zihao=-4]{ctexart}

\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[a4paper,margin=2.5cm]{geometry}
\usepackage{hyperref}

\title{论文题目}
\author{作者一\thanks{单位，邮箱：\texttt{author@example.edu}} \and 作者二}
\date{\today}

\begin{document}

\maketitle

\begin{abstract}
本文研究了……问题。针对现有方法……的不足，提出了一种……方法。
在标准数据集上的实验表明，所提方法在准确率上比基线提升 1.4 个百分点。

\noindent\textbf{关键词：}关键词一；关键词二；关键词三
\end{abstract}

\section{引言}
近年来，深度学习在众多任务上取得了显著进展\cite{vaswani2017attention}。然而……
本文的主要贡献如下：
\begin{enumerate}
  \item 指出了……；
  \item 提出了……；
  \item 通过实验验证了……。
\end{enumerate}

\section{相关工作}
扩散模型\cite{ho2020denoising}……

\section{方法}
给定训练集 $\mathcal{D} = \{(x_i, y_i)\}_{i=1}^{N}$，模型的优化目标为
\begin{equation}
  \mathcal{L}(\theta) = \frac{1}{N} \sum_{i=1}^{N} \ell\bigl(f_\theta(x_i), y_i\bigr)
  + \lambda \lVert \theta \rVert_2^2 .
  \label{eq:loss}
\end{equation}
采用随机梯度下降求解式~\eqref{eq:loss}：
\begin{align}
  g_t      &= \nabla_\theta \mathcal{L}(\theta_{t-1}), \\
  \theta_t &= \theta_{t-1} - \eta_t \, g_t .
\end{align}

\section{实验}
表~\ref{tab:main} 给出了在 CIFAR-10 上的主要结果（3 个随机种子的均值）。

\begin{table}[htbp]
  \centering
  \caption{CIFAR-10 上的主要结果}
  \label{tab:main}
  \begin{tabular}{lccc}
    \hline
    方法   & 参数量（M） & 准确率（\%）   & 损失           \\
    \hline
    基线   & 25.6        & 95.4           & 0.162          \\
    本文   & 25.9        & \textbf{96.8}  & \textbf{0.121} \\
    \hline
  \end{tabular}
\end{table}

\section{结论}
本文提出了……未来工作包括……

\begin{thebibliography}{9}
\bibitem{vaswani2017attention}
A.~Vaswani, N.~Shazeer, N.~Parmar, et~al.
\newblock Attention is all you need.
\newblock In \emph{Advances in Neural Information Processing Systems}, 2017.

\bibitem{ho2020denoising}
J.~Ho, A.~Jain, and P.~Abbeel.
\newblock Denoising diffusion probabilistic models.
\newblock In \emph{Advances in Neural Information Processing Systems}, 2020.
\end{thebibliography}

\end{document}
`;

const BLANK_LATEX = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath,amssymb}

\title{Untitled}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}

\end{document}
`;

// ---------------------------------------------------------------- 汇总

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: 'blank-doc',
    kind: 'doc',
    title: tr('空白文档'),
    description: tr('从一张白纸开始写'),
    markdown: '',
    blank: true,
  },
  {
    id: 'weekly-report',
    kind: 'doc',
    title: tr('实验周报'),
    description: tr('本周进展、实验结果、问题与下周计划'),
    markdown: WEEKLY,
  },
  {
    id: 'reading-notes',
    kind: 'doc',
    title: tr('论文阅读笔记'),
    description: tr('问题、方法、实验、优缺点与启发'),
    markdown: READING_NOTES,
  },
  {
    id: 'research-proposal',
    kind: 'doc',
    title: tr('研究计划书'),
    description: tr('背景、现状、目标、技术路线与进度'),
    markdown: PROPOSAL,
  },
  {
    id: 'meeting-minutes',
    kind: 'doc',
    title: tr('会议纪要'),
    description: tr('议程、讨论要点、决议与行动项'),
    markdown: MINUTES,
  },
  {
    id: 'blank-sheet',
    kind: 'sheet',
    title: tr('空白表格'),
    description: tr('自由记录数据，支持公式'),
    markdown: '',
    blank: true,
  },
  {
    id: 'experiment-sheet',
    kind: 'sheet',
    title: tr('实验数据记录表'),
    description: tr('编号、模型、数据集、超参与指标，一行一次实验'),
    markdown: EXPERIMENT_SHEET,
  },
  {
    id: 'literature-sheet',
    kind: 'sheet',
    title: tr('文献追踪表'),
    description: tr('论文清单、阅读状态、相关度与负责人'),
    markdown: LITERATURE_SHEET,
  },
  {
    id: 'blank-slides',
    kind: 'slides',
    title: tr('空白幻灯片'),
    description: tr('从第一页开始讲'),
    markdown: tr('## 标题\n\n副标题\n'),
    blank: true,
  },
  {
    id: 'group-meeting-slides',
    kind: 'slides',
    title: tr('组会汇报'),
    description: tr('封面、进展、结果、讨论、计划、Q&A'),
    markdown: GROUP_MEETING_SLIDES,
  },
  {
    id: 'paper-sharing-slides',
    kind: 'slides',
    title: tr('论文分享'),
    description: tr('背景、方法、实验、优缺点与启发'),
    markdown: PAPER_SHARING_SLIDES,
  },
  {
    id: 'blank-latex',
    kind: 'latex',
    title: tr('空白 LaTeX'),
    description: tr('最小可编译的 article 骨架'),
    markdown: BLANK_LATEX,
    blank: true,
  },
  {
    id: 'latex-article',
    kind: 'latex',
    title: tr('学术论文（article）'),
    description: tr('摘要、引言、方法、实验、结论与参考文献'),
    markdown: ARTICLE_LATEX,
  },
  {
    id: 'latex-ctexart',
    kind: 'latex',
    title: tr('中文论文（ctexart）'),
    description: tr('ctexart 中文排版，XeLaTeX 编译'),
    markdown: CTEX_LATEX,
  },
];

/** 按类型分组（模板画廊用），保持 DOC_TEMPLATES 里的顺序 */
export function templatesByKind(kind: DocumentKind): DocTemplate[] {
  return DOC_TEMPLATES.filter((t) => t.kind === kind);
}
