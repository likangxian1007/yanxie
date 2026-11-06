import { ResearchItem, ResearchRelation } from './research-workspace';

export const RESEARCH_WORKSPACE_EVENT_PAYLOADS = {
  'research.item.created': ResearchItem,
  'research.item.updated': ResearchItem,
  'research.item.archived': ResearchItem,
  'research.relation.created': ResearchRelation,
  'research.relation.updated': ResearchRelation,
  'research.relation.archived': ResearchRelation,
} as const;
