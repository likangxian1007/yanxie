# 通用科研公开验收材料

这些小型资料固定用于离线集成测试，不在测试运行时下载。`manifest.json` 记录原始下载地址、获取日期、原文件和收录文件的 SHA-256、使用说明及许可出处。更新资料必须同时更新 manifest 并检查受影响的验收结果，不能用更新预期值掩盖行为回归。

| 方法     | 材料与操作                                                          | 需要保留的限制                                            |
| -------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| 计算仿真 | UCI Iris 的 150 条数据；每五行取一行测试，其余用于最近质心分类      | 这里只验证固定计算及记录链路，不据此作模型优劣或领域结论  |
| 实体实验 | NIST Misra1a 的 14 条已发表吸附观测，按原文参数重算残差平方和       | 数据来自他人实验；本团队没有重新做实验，原资料未注明单位  |
| 调查观测 | Palmer Penguins 的 344 行观测，保留 NA，重算鳍长的非缺失计数与均值  | 描述统计不作因果解释，缺失值不填成零                      |
| 质性研究 | Wollstonecraft 原文第一段摘录，建立教育／自主主题编码和材料对象代号 | 属于公开文本分析，不伪装为访谈样本；编码是验收示例解释    |
| 文献史料 | 同书另一段摘录，登记电子版本、原始行号和对 Rousseau 的转引          | 转引尚未核对 Rousseau 原始文本，不能写成直接读过原作      |
| 理论推导 | mathlib 的素数无穷命题源文件，固定提交与命题位置                    | 仅登记来源与推导说明，验收不运行 Lean，不称为机器证明验证 |

混合方法案例让质性和文献记录共享同一个来源与快照，并互相关联；不会复制文件假装共享。所有代码运行结果由测试当场计算后写入过程日志。文档中的六类案例通过只表明软件功能闭环通过，不代表研究方法已获领域专家认可。

## 出处与使用说明

- Iris：Fisher, R. A.，UCI Machine Learning Repository，[DOI 10.24432/C56C76](https://doi.org/10.24432/C56C76)，CC BY 4.0。从上游归档的 `iris.data` 添加列标题，原始数值未改动。
- Palmer Penguins：Horst, Hill & Gorman (2020)，[项目仓库](https://github.com/allisonhorst/palmerpenguins)，CC0 1.0；固定提交见 manifest。
- Misra1a：Misra, D. (1978), Dental Research Monomolecular Adsorption Study，NIST/ITL Statistical Reference Datasets。原始字节保存在 `misra1a-original.dat.gz`，解压后摘要等于 manifest 的 `upstreamSha256`；测试副本仅统一 LF 与行末空白，观测值不变；[NIST 数据使用条款](https://www.nist.gov/open/license)。数据按原样提供，本项目不代表 NIST 对研究结果作任何保证或背书。
- Wollstonecraft：1792 年英文原作的公有领域文字；电子转录 Amy E Zelmer、Col Choat、Sue Asscher，[Project Gutenberg #3420](https://www.gutenberg.org/ebooks/3420)，2021-01-08 版。仅收录两段原作，合并换行，保留原文；不是新译文或网站生成的内容摘要。
- mathlib：Copyright (c) 2015 Microsoft Corporation；作者 Leonardo de Moura、Jeremy Avigad、Mario Carneiro。文件按 Apache-2.0 原样收录，许可全文见 `MATHLIB-LICENSE.txt`。
