// 文件按归属拆分，避免并行线程在同一处追加造成冲突：
// 后端线程：entities.ts / api.ts / events.ts；协作线程：*-collab.ts（见 ARCHITECTURE.md §2.1）
export * from './ids';
export * from './enums';
export * from './entities';
export * from './entities-collab';
export * from './events-collab';
export * from './events';
export * from './ws';
export * from './errors';
export * from './api';
export * from './api-collab';
export * from './slides-collab';
export * from './format';
export * from './notebooks';
export * from './desktop';
export * from './harness';
// 文献库（feat/paper-library）
export * from './entities-library';
export * from './events-library';
export * from './api-library';
export * from './format-library';
// 版本管理（feat/versioning）
export * from './versioning';
// 通用科研工作流
export * from './research';
export * from './research-templates';
// 个人 / 团队空间与分享（feat/personal-team-spaces）
export * from './sharing';
// 自由组织研究工作区
export * from './research-workspace';
export * from './research-execution';
export * from './events-research-execution';

export * from './research-content';
// 正式方案、探索副本与团队依据（feat/plans-and-team-memory）
export * from './plans';

export * from './mentions';
export * from './research-processing';

// 接入：API 令牌（feat/api-tokens）
export * from './integrations';
// 接入：通知订阅（飞书 / 企业微信 / 钉钉 群机器人）
export * from './notify';
// 界面语言（中 / 英）
export * from './i18n';
// 反馈中心、更新日志、站内通知与运维后台（feat/feedback-center）
export * from './feedback';
// 按量计费与 KyrenPay 充值（feat/models-billing）
export * from './billing';
// 本地 + 云端混合 AI（feat/hybrid-local-ai）
export * from './hybrid';
