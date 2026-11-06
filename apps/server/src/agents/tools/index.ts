import type { AgentRole } from '@srh/shared';
import type { AppContext } from '../../context';
import { collabTools } from './collab';
import { fileTools } from './files';
import { githubTools } from './github';
import { latexTools } from './latex';
import { libraryTools } from './library';
import { messagingTools } from './messaging';
import { notebookTools } from './notebooks';
import { projectTools } from './project';
import { researchTools } from './research';
import { researchWorkspaceTools } from './research-workspace';
import type { ToolDef } from './types';
import { visionTools } from './vision';
import { webTools } from './web';

/**
 * 工具注册表。名称与 prompts/ 里完全一致；本会话实际可用的工具名会填进 {{tool_list}}。
 * 某些工具只在条件满足时出现（协作模块已注册端口、联网已开启）。
 */
export const ALL_TOOLS: ToolDef[] = [
  ...messagingTools,
  ...projectTools,
  ...collabTools,
  ...latexTools,
  ...notebookTools,
  ...fileTools,
  ...visionTools,
  ...webTools,
  ...libraryTools,
  ...githubTools,
  ...researchTools,
  ...researchWorkspaceTools,
];

export function toolsFor(ctx: AppContext, role: AgentRole): ToolDef[] {
  return ALL_TOOLS.filter((t) => t.roles.includes(role) && (t.enabled?.(ctx) ?? true));
}
