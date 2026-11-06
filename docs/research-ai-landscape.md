# 科研 AI 工具调研与科研 Profile 设计

> 目的：了解现有科研 AI 产品和开源研究 agent 怎么组织"科研对话"，总结研究者和 AI 打交道的常见模式，挑出值得集成的论文读取/拆分开源项目，并说明我们预置的科研 Profile 和 Skill 是怎么设计的。
> 配套种子数据：`apps/server/src/modules/harness/profiles.seed.json`（11 个 Profile）、`apps/server/src/modules/harness/skills.seed.json`（14 个 Skill）。
> 调研时间：2026-10。许可证信息于同月通过 GitHub API 核对，集成前请再确认一次。

---

## 1. 结论速览

1. **好用的科研 AI，核心不在聊天，而在"带证据的结构化产出"。** Elicit 的抽取表格、Consensus 的共识仪表、PaperQA2 和 OpenScholar 的逐句引用、deep research 的带引用报告，都是把回答固定成可核验的结构。
2. **对话要分阶段：先澄清，再计划，然后执行，最后汇报。** OpenAI deep research 动手前会先问澄清问题；Agent Laboratory 的结论是，每个阶段都让人给反馈，研究质量会明显提高；Co-STORM 允许用户随时插话、调整方向。
3. **想法生成的主流做法是"多角色辩论加锦标赛"。** Google AI co-scientist 用多个 agent 反复生成、评审、排名、进化假设。这套流程在单个 agent 里分角色执行也能用。
4. **引用幻觉是头号风险。** OpenScholar 报告 GPT-4o 在其评测中 78%–90% 的引用是编造的。所以我们把"引用核验"做成独立 Skill，并让多数 Profile 强制挂载。
5. **"拆论文"有现成的开源基础设施。** arXiv 论文优先用 HTML 或 LaTeX 源；PDF 结构化用 GROBID（Apache-2.0）；版面转 Markdown 用 Docling（MIT）或 MinerU。建议做成"论文解析服务 + MCP 工具"，让所有 Profile 共用。

---

## 2. 产品与开源项目逐个看

每个条目说明三件事：**做什么**、**对话怎么组织**、**我们借鉴什么**。

### 2.1 商业产品

#### Elicit

- **做什么**：面向文献综述和系统综述，覆盖检索、筛选（screening）、按列抽取数据。已有研究专门评估过它在系统综述中的辅助效果，见 [medRxiv 2026 评估](https://www.medrxiv.org/content/medrxiv/early/2026/10/05/2026.10.02.26364621.full.pdf) 和 [TAMUK LibGuide](https://libguides.tamuk.edu/c.php?g=1480428&p=11032071)。
- **对话组织**：基本不是聊天，而是一张**表格**。行是论文，列是用户自定义的问题（样本量、方法、结论……），每个单元格都附原文引用片段。
- **借鉴**：`related-work-matrix` 用的就是"维度 × 论文"矩阵；无法从原文确认的格子填"?"，不允许猜。

#### Consensus

- **做什么**：基于论文库回答研究问题。对是/否类问题给出 **Consensus Meter**，汇总相关论文中"是 / 可能 / 否"的比例，见 [Consensus Meter 帮助页](https://help.consensus.app/en/articles/10069920-the-consensus-meter) 和 [验证研究问题指南](https://consensus.app/home/resources/consensus-validate-research-guide/)。
- **对话组织**：鼓励用户把问题改写成可检验的形式（"X 是否提高 Y？"），然后展示证据分布，而不是只给一个结论。
- **借鉴**：综述 Profile 要求输出"共识与争议"，并区分 preprint 和同行评审论文；`literature-search-protocol` 要求先把问题拆成要素。

#### SciSpace

- **做什么**：Chat with PDF。可以选中段落、公式或表格让 AI 解释，也提供浏览器插件，见 [Chat with PDF 介绍](https://scispace.com/resources/scispace-live-workshop-for-researchers/chat-with-pdf-using-scispace/) 和 [Chrome 插件](https://chromewebstore.google.com/detail/scispace-do-hours-of-rese/cipccbpjpemcnijhjcdjmkjhmhniiick)。
- **对话组织**：以单篇论文为上下文，围绕"选中内容"提问，回答定位到原文位置。
- **借鉴**：`paper-reader` 的追问模式，要求回答定位到章节、式号、表号；将来前端可以支持"选中段落 → 带入对话"。

#### OpenAI deep research

- **做什么**：自主多步检索网页和资料，生成带引用的长报告，见 [OpenAI 帮助中心](https://help.openai.com/zh-hant-hk/articles/10500283-deep-research-in-chatgpt)。
- **对话组织**：**先问 1–3 个澄清问题**（范围、侧重、时间窗），再长时间自主执行，最后交付一份报告，过程中展示检索轨迹。
- **借鉴**：所有 Profile 的第一步都是"先澄清约束"；耗时任务先给 3–6 步计划；文献调研保留检索日志。

#### OpenAI Prism

- **做什么**：2026 年初发布的免费 AI 原生 LaTeX 写作工作区，模型嵌在文档里，支持多人协作，见 [Introducing Prism](https://openai.com/zh-Hans-CN/index/introducing-prism/) 和 [OpenAI 帮助中心](https://help.openai.com/mk-mk/articles/20001050-troubleshooting-and-getting-help-in-prism)。
- **对话组织**：AI 在文档内工作，可以就地改写、补公式、修编译错误、整理参考文献，**和合作者共享同一份文档**。
- **借鉴**：写作、组会、综述类 Profile 统一要求长产出走 `create_document / edit_document`，形成可协作编辑的文档，而不是停在聊天记录里。这也是我们"协同能力"的落点。

#### Google AI co-scientist

- **做什么**：基于 Gemini 的多 agent 系统，专门生成科研假设。在药物重定位、靶点发现、抗菌耐药机制等方向有湿实验验证，论文已发表在 Nature (2026)，见 [arXiv:2502.18864](https://arxiv.org/abs/2502.18864) 和 [DeepMind 博客](https://deepmind.google/blog/co-scientist-a-multi-agent-ai-partner-to-accelerate-research/)。
- **对话组织**：科学家先用自然语言给出研究目标和约束。系统里的 Generation、Reflection、Ranking（Elo 锦标赛）、Evolution、Meta-review 等 agent 异步循环工作，科学家可以随时补充想法或评审意见。
- **借鉴**：`idea-tournament` 把"多策略生成 → 查新评审 → 两两比较排名 → 进化"落到单个 agent 里；`idea-brainstorm` Profile 的推理档位设为 `max`。

#### Claude for Life Sciences

- **做什么**：Anthropic 面向生命科学的方案，组合了 Benchling、PubMed、BioRender、10x Genomics 等 **Connectors**（MCP），首个科学 **Agent Skill** `single-cell-rna-qc`，以及一个 prompt library，见 [Anthropic 公告](https://www.anthropic.com/news/claude-for-life-sciences)。
- **对话组织**：模型本身保持通用，靠"连接器提供数据和工具 + Skill 固化领域规程 + 示例 prompt 降低上手门槛"三层叠加。
- **借鉴**：这和我们的 **Profile（角色）+ Skill（规程）+ MCP（工具）+ starters（示例开场）** 结构几乎一一对应。Skill 用"何时加载"的描述做目录，按需加载正文，不占上下文。

### 2.2 开源研究 agent

| 项目                                                                                                                                                               | 许可证                           | 做什么 / 对话组织                                                                                                                         | 我们借鉴什么                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [PaperQA2](https://github.com/Future-House/paper-qa)（[论文](https://arxiv.org/abs/2409.13740)）                                                                   | Apache-2.0                       | 面向科学文献的 agentic RAG：检索论文 → 收集证据片段并打相关性分 → 引文追踪 → 生成带引用的答案；还能检测文献之间的矛盾                     | "证据片段 → 答案"两步走；回答前先收集证据；矛盾检测写进综述的"争议"部分                                                            |
| [STORM / Co-STORM](https://github.com/stanford-oval/storm)（[Co-STORM 论文](https://aclanthology.org/2024.emnlp-main.554/)）                                       | MIT                              | 从多视角提问，模拟"写作者 ↔ 专家"对话来收集资料，先出大纲再写带引用的长文；Co-STORM 让用户加入圆桌讨论，并维护一张动态思维导图            | 综述先搭"领域地图 / 大纲"再成文；多视角提问                                                                                        |
| [OpenScholar](https://github.com/AkariAsai/OpenScholar)（[arXiv](https://arxiv.org/abs/2411.14199)、[Nature](https://www.nature.com/articles/s41586-025-10072-4)） | Apache-2.0                       | 4500 万篇开放论文的检索库，加上自反馈迭代检索与生成；引用准确率接近人类专家                                                               | 引用核验 Skill 的依据；以后可以把它的数据库或检索器接成 MCP 检索源                                                                 |
| [AI Scientist v1/v2](https://github.com/SakanaAI/AI-Scientist)（[Sakana](https://sakana.ai/ai-scientist-nature/)）                                                 | 自定义 RAIL 系源码许可（非 OSI） | 全自动完成 idea → 代码实验 → 写论文 → 自动审稿；v2 用 agentic tree search                                                                 | 只借鉴"自动审稿"这一环，做成 `internal-review` Profile；**不建议直接集成代码**（许可证限制较多，且全自动产出的质量和伦理风险都高） |
| [Agent Laboratory](https://github.com/SamuelSchmidgall/AgentLaboratory)（[arXiv](https://arxiv.org/abs/2501.04227)）                                               | MIT                              | 用户给出 idea，系统分三阶段（文献综述 → 实验 → 报告）完成，有 co-pilot 模式，每个阶段接收人工反馈；论文结论是"人类逐阶段反馈显著提升质量" | 各 Profile 都按阶段走，阶段之间把结果交给用户确认；Profile 之间的衔接（如 idea → 实验设计 → 复现）                                 |
| [GPT-Researcher](https://github.com/assafelovic/gpt-researcher)                                                                                                    | Apache-2.0                       | planner 生成子问题，多个 executor 并行检索，最后汇总成带引用的报告                                                                        | 综述任务拆成子问题并行检索；以后可以把它当作后台 deep-research 服务接入                                                            |
| [local-deep-research](https://github.com/LearningCircuit/local-deep-research)                                                                                      | MIT                              | 本地 LLM 也能跑的深度研究，内置 arXiv、PubMed 等 10 多个检索源                                                                            | 私有化或离线部署时可以参考                                                                                                         |

---

## 3. 研究者怎么和 AI 对话：常见模式

根据上面的产品设计和我们对研究者日常工作的归纳，高频场景和对应的好做法如下。

| 场景           | 典型开场                       | AI 应该怎么接                                                    | 对应 Profile                      |
| -------------- | ------------------------------ | ---------------------------------------------------------------- | --------------------------------- |
| 摸底一个新方向 | "帮我了解一下 X 的现状"        | 先问时间窗和目的，然后检索、画领域地图、列代表作，给链接         | literature-review                 |
| 读一篇论文     | 贴链接或 PDF："帮我读一下"     | 结构化拆解，回答追问时定位到原文，区分作者声称和自己的判断       | paper-reader                      |
| 找选题         | "我在做 X，有什么可以做的？"   | 先问资源和约束，多策略发散，查新，排序，给最小可行实验           | idea-brainstorm                   |
| 验证 idea      | "这个 idea 值得做吗？"         | 查新，用 Heilmeier 问题评估，做预验尸，站在审稿人角度攻击        | idea-brainstorm / internal-review |
| 设计实验       | "实验怎么设计 / 消融怎么做？"  | 从论文要证明的论点倒推实验，设强基线，多 seed，按优先级排预算    | experiment-design                 |
| 分析结果       | 贴表格或 CSV："我的方法好吗？" | 用代码实际运行检验，报告效应量和置信区间，提示风险               | data-analysis                     |
| 作图           | "帮我画成论文图"               | 先明确这张图要证明什么，统一配色、矢量导出、写图注               | data-analysis                     |
| 写作和润色     | "润色这段 / 翻成英文"          | 保持原意，给出修改稿和修改说明，不改变论断强度                   | paper-writing                     |
| 审稿回复       | 贴审稿意见                     | 逐条编号分类，制定行动计划，证据优先，不编造结果                 | rebuttal                          |
| 组会           | "帮我准备组会"                 | 标题即结论，负结果也要讲，预判提问                               | group-meeting                     |
| 复现           | "复现这篇 / 我的数比论文低"    | 先审计论文和代码，先跑官方 checkpoint 对齐评测，再按顺序排查差异 | code-repro                        |

**跨场景的共性规则**（已写进每个 Profile 的 prompt）：

1. **先澄清再动手**：领域、目标产出、截止时间、算力、目标 venue。
2. **证据可追溯**：事实性陈述都带 arXiv ID、DOI、URL 或文件位置；数字注明表号。
3. **零编造**：参考文献、实验数据、统计结果、审稿回复里的新结果一律不编；缺失内容用【待填】或【待补】占位。
4. **分清三类信息**：文献结论、模型推断（标【推断】）、领域常识；不确定处标置信度。
5. **敢于反对**：发现前提、数据或推理有问题时直接指出（idea 评估和模拟审稿尤其如此）。
6. **长产出进文档**：方便合作者编辑和评论，这是协同能力的落点。

---

## 4. 论文读取 / 拆分开源项目推荐

### 4.1 总体建议：分层解析

```
arXiv 论文 ──► 优先 arXiv HTML (arxiv.org/html/<id>) / LaTeX 源 (arxiv.org/src/<id>)  ← 最准，无需 OCR
其它 PDF   ──► GROBID：元数据 + 章节树 + 参考文献 + 引文锚点 (TEI XML)
           └► Docling / MinerU：版面 → Markdown（公式 LaTeX、表格、图片），供 LLM 阅读
元数据/检索 ──► Semantic Scholar API / OpenAlex / Crossref / DBLP（引用核验与滚雪球）
```

把这几层封装成一个**论文解析服务**，对外提供 MCP 工具：`paper_fetch(id|url) → {meta, sections[], refs[], figures[], tables[]}` 和 `paper_section(id, name)`。`paper-reader`、`code-repro`、`literature-review` 等 Profile 都可以复用，长论文也能按章节分段读，不会一次塞满上下文。

### 4.2 候选项目

| 项目                                                                                                            | 许可证                                                                                                  | 强项                                                                                                     | 集成建议                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [GROBID](https://github.com/kermitt2/grobid)                                                                    | Apache-2.0                                                                                              | 学术 PDF 专用：标题、作者、摘要、章节、**参考文献解析与引文锚点**，输出 TEI XML；CPU 可跑，有官方 Docker | **首选**，用于结构拆分和参考文献抽取，`citation-verify` 和"滚雪球"直接受益。以 Docker 服务形式部署，通过 REST 调用，不涉及代码链接 |
| [Docling](https://github.com/docling-project/docling)                                                           | MIT                                                                                                     | IBM 出品，PDF、DOCX、PPTX 转 Markdown 或 JSON，版面、表格结构识别好，生态完善                            | **首选**，用于正文转 Markdown。MIT 许可最省心，可以直接作为 Python 依赖                                                            |
| [MinerU](https://github.com/opendatalab/MinerU)                                                                 | Apache-2.0 + 附加条款（MAU 超 1 亿或月收入超 2000 万美元需商业授权；在线服务有署名义务）                | 中文和公式表现强，输出 Markdown 或 JSON，社区活跃                                                        | 中文论文、公式密集的论文用它；对外提供服务时注意署名条款                                                                           |
| [marker](https://github.com/datalab-to/marker)                                                                  | 代码 Apache-2.0；**模型权重为修改版 OpenRAIL-M**（研究、个人和年收入或融资低于 500 万美元的初创可免费） | 速度快，精度高，输出 Markdown / JSON                                                                     | 商用前需评估权重许可；可作为备选                                                                                                   |
| [Nougat](https://github.com/facebookresearch/nougat)                                                            | MIT（代码）                                                                                             | 学术 PDF（含公式）端到端 OCR 转 Markdown                                                                 | 已基本停更，作为扫描版老论文的兜底                                                                                                 |
| [olmOCR](https://github.com/allenai/olmocr)                                                                     | Apache-2.0                                                                                              | 基于 VLM 的 PDF 线性化，适合大批量处理                                                                   | 需要 GPU；批量建本地论文库时可以考虑                                                                                               |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)                                                          | Apache-2.0                                                                                              | OCR 和文档结构化，支持 100 多种语言                                                                      | 扫描件或图片场景使用                                                                                                               |
| [PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate)                                                  | **AGPL-3.0**                                                                                            | 保留排版的论文全文双语翻译，自带 MCP 和 Zotero 插件                                                      | 适合中文用户"对照读论文"。因为是 AGPL，**只能以独立进程或外部 MCP 服务方式对接**，不要把代码并入我们的仓库                         |
| [PaperQA2](https://github.com/Future-House/paper-qa)                                                            | Apache-2.0                                                                                              | 本地论文库上的高精度带引用问答                                                                           | 适合"项目文献库问答"，可封装成 MCP                                                                                                 |
| [papermage](https://github.com/allenai/papermage) / [s2orc-doc2json](https://github.com/allenai/s2orc-doc2json) | Apache-2.0                                                                                              | AllenAI 的论文结构化表示和解析器                                                                         | 近年更新少，可参考其数据结构设计                                                                                                   |
| [Zotero](https://github.com/zotero/zotero)                                                                      | AGPL-3.0                                                                                                | 研究者事实上的标准文献库                                                                                 | **通过 Zotero Web API 或本地 API 对接**（读取用户文献库和 PDF 附件），不引入其代码                                                 |

> 许可证提醒：GROBID、Docling、PaperQA2、STORM、GPT-Researcher、Agent Laboratory 都是 Apache 或 MIT，可以放心使用。PDFMathTranslate 和 Zotero 是 AGPL，只能走进程或网络隔离。marker 的权重和 MinerU 的附加条款要在商用前确认。AI Scientist 是非 OSI 的 RAIL 系许可，只参考思路。

---

## 5. 我们的科研 Profile 设计

### 5.1 三层结构

| 层          | 是什么                                                                                                                                                   | 存放                 | 用户能否编辑                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| **Profile** | 角色 prompt + 默认 Skill 列表 + 开场建议（starters）+ 推荐推理档位                                                                                       | `profiles.seed.json` | 可以。按项目或会话选用，可复制后修改                                |
| **Skill**   | 一套具体规程，包括步骤、清单、输出模板和红线；`description` 写明"何时加载"                                                                               | `skills.seed.json`   | 可以。agent 先只看目录（slug、name、description），需要时才加载正文 |
| **工具**    | web_search（arXiv）、fetch_url、read_file、write_file、list_files、create_document / edit_document、MCP（将来接入论文解析、Zotero、Semantic Scholar 等） | 运行时               | 由部署方配置                                                        |

这样设计的理由：

- **Profile 只管"做事方式"**：角色、流程、输出形态、严谨性规则。具体规程放在 Skill 里，多个 Profile 共享，避免重复，也便于统一升级（比如改进引用核验规程，所有挂载它的 Profile 一起受益）。
- **Skill 按需加载**：目录里只有一句触发描述，不占上下文，和 Claude Agent Skills 的思路一致。
- **starters 降低上手门槛**：对应 Claude for Life Sciences 的 prompt library，研究者点一下就能开始。
- **effort 推荐值**：头脑风暴、审稿回复、模拟审稿需要深度推理，设为 `max`；组会整理设为 `low`；其余设为 `high`。

### 5.2 Profile 一览（11 个）

| slug               | 名称                         | 默认 Skill                                                                        | effort |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------- | ------ |
| research-assistant | 通用科研助理（建议作为默认） | literature-search-protocol, paper-deep-read, citation-verify                      | high   |
| literature-review  | 文献调研与综述               | literature-search-protocol, paper-deep-read, related-work-matrix, citation-verify | high   |
| paper-reader       | 论文精读与拆解               | paper-deep-read, citation-verify, repro-checklist                                 | high   |
| idea-brainstorm    | 选题与 Idea 头脑风暴         | idea-tournament, idea-critique, literature-search-protocol, related-work-matrix   | max    |
| experiment-design  | 实验设计与消融               | ablation-plan, stats-check, repro-checklist                                       | high   |
| data-analysis      | 数据分析与作图               | stats-check, figure-style                                                         | high   |
| paper-writing      | 论文写作与润色（中英）       | paper-section-writing, academic-polish-zh-en, citation-verify, figure-style       | high   |
| rebuttal           | 审稿意见回复                 | rebuttal-letter, ablation-plan, academic-polish-zh-en, citation-verify            | max    |
| group-meeting      | 组会汇报                     | group-meeting-report, paper-deep-read, figure-style                               | low    |
| code-repro         | 代码复现                     | repro-checklist, paper-deep-read, stats-check                                     | high   |
| internal-review    | 投稿前模拟审稿               | paper-deep-read, idea-critique, stats-check, ablation-plan, citation-verify       | max    |

### 5.3 Skill 一览（14 个）

| slug                       | 作用                                                       | 借鉴来源                                         |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| literature-search-protocol | 检索式构造、多源检索、滚雪球、筛选和检索日志               | PRISMA、Elicit、deep research                    |
| paper-deep-read            | 拆论文：问题 / 方法 / 实验 / 证据强度 / 局限 / 可复现点    | SciSpace、三遍读法                               |
| related-work-matrix        | 论文 × 维度对比矩阵，按路线分组，找研究空白                | Elicit 表格、STORM 大纲                          |
| citation-verify            | 核验引用的存在性、元数据，以及是否真的支撑论点             | OpenScholar、PaperQA2                            |
| idea-tournament            | 多策略生成、查新、锦标赛排序、进化                         | Google AI co-scientist                           |
| idea-critique              | Heilmeier 问题、预验尸、审稿人视角                         | DARPA Heilmeier Catechism、AI Scientist 自动审稿 |
| ablation-plan              | 从论文论点倒推实验矩阵，设计消融和敏感性分析，排算力优先级 | Agent Laboratory 实验阶段                        |
| stats-check                | 检验方法选择、效应量、常见陷阱                             | ML 实验统计实践                                  |
| figure-style               | 选图型、配色、尺寸、导出，提供 matplotlib 模板             | 期刊作图规范                                     |
| paper-section-writing      | 论文各节模板（CARS 引言、4–6 句摘要）                      | 学术写作通行框架、Prism                          |
| academic-polish-zh-en      | 中英润色与互译，去中式英语和 AI 腔                         | 语言编辑实践                                     |
| rebuttal-letter            | 意见拆解、行动计划、回复模板                               | 会议和期刊回复惯例                               |
| group-meeting-report       | 进展汇报和 journal club 两种结构                           | 课题组惯例                                       |
| repro-checklist            | 复现审计、环境锁定、由浅入深、差异排查、复现报告           | ML Reproducibility Checklist                     |

### 5.4 使用与扩展

- **选用**：创建项目时选一个默认 Profile，比如博士生的毕业课题可以选 `research-assistant`；单个会话可以切换到别的 Profile，比如收到审稿意见那天切到 `rebuttal`。
- **编辑**：Profile 和 Skill 都是纯数据，前端提供表单编辑，支持"复制为我的版本"，课题组可以沉淀自己的写作规范、作图配色和组会模板。
- **领域扩展**：参考 Claude for Life Sciences，后续可以按学科增加 Skill，例如 `single-cell-qc`、`clinical-stats`、`latex-beamer`、`theorem-proof-check`，再配上对应的 MCP（PubMed、Benchling、Zotero、论文解析服务）。
- **协同**：多人项目中，长产出（综述、实验矩阵、回复信、组会文档）一律落到协作文档。Profile 的 prompt 已写入这一要求，便于导师批注、同门接手。

---

## 6. 下一步建议（按优先级）

1. **P0**：部署 GROBID 和 Docling，封装成论文解析 MCP（`paper_fetch` / `paper_section`）。arXiv 论文优先走 HTML 或 LaTeX 源。
2. **P0**：接入 Semantic Scholar 和 OpenAlex 检索 API 作为 MCP，让 `citation-verify` 和滚雪球检索可以稳定执行。
3. **P1**：对接 Zotero Web API，读取用户已有的文献库，用于项目内文献问答（可参考 PaperQA2）。
4. **P1**：前端支持在论文阅读视图中选中段落并带入对话（SciSpace 模式），综述矩阵做成可编辑表格（Elicit 模式）。
5. **P2**：后台 deep-research 任务（参考 GPT-Researcher 或 STORM），用于耗时较长的综述，完成后通知用户。

## 7. 2026-10-28 实施补充

上文是 2026-10 的设计调研与当时建议，不能当作当前工具清单或已实现功能。当前研协已具备多来源学术检索与项目文献库；第 6 节关于「接入 Semantic Scholar 和 OpenAlex」及「部署论文解析」的建议需按代码现状重新核对，不能据此声称现在只有 arXiv 或尚无全文读取。Zotero、OSF、protocols.io 和 NVivo 在本次工作中只是机制参考，不表示已有平台集成。

本次新增跨方法研究记录：预置通用、计算仿真、实体实验、调查观测、质性、文献史料、理论推导模板；项目可发布新模板版本，旧记录保留绑定版本。资料快照和摘录固定来源及原文位置，发现区分支持、反例与语境，导出带来源关系。这个方向分别参考了 [OSF 的登记与时间戳计划](https://help.osf.io/article/330-welcome-to-registrations)、[protocols.io 的步骤式规程编辑](https://www.protocols.io/help/editor)、[Zotero 对书籍、手稿和数据集等条目类型的支持](https://www.zotero.org/support/kb/item_types_and_fields)、[NVivo 对主题代码和案例的区分](https://community.lumivero.com/s/article/NV12Mac-About-codes)。上述资料只支持这些机制性借鉴，领域适配仍需研究者试用。
