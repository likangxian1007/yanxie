/** 混合 AI 看板与脱敏预览只给网页会话用：会探测本机模型、调用本机推理。 */
export const HYBRID_INTERACTIVE_ROUTES = new Set([
  'GET /hybrid/status',
  'POST /hybrid/redact-preview',
]);
