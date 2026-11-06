import { ResearchRecipe, ResearchRun } from './research-execution';

/** 状态事件只传轻量版本通知，原文和冻结产物按权限单独读取。 */
export const ResearchRunNotice = ResearchRun.pick({
  id: true,
  projectId: true,
  recordId: true,
  status: true,
  cancelRequested: true,
  updatedAt: true,
});
export const ResearchRecipeNotice = ResearchRecipe.pick({
  id: true,
  projectId: true,
  recordId: true,
  title: true,
  version: true,
  createdAt: true,
});
export const RESEARCH_EXECUTION_EVENT_PAYLOADS = {
  'research.run.created': ResearchRunNotice,
  'research.run.updated': ResearchRunNotice,
  'research.recipe.published': ResearchRecipeNotice,
} as const;
