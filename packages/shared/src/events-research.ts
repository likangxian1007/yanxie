import {
  EvidenceExcerpt,
  ResearchCode,
  ResearchCoding,
  ResearchFinding,
  ResearchLog,
  ResearchRecord,
  ResearchSnapshot,
  ResearchSource,
  ResearchTemplate,
} from './research';

export const RESEARCH_EVENT_PAYLOADS = {
  'research.template.published': ResearchTemplate,
  'research.record.created': ResearchRecord,
  'research.record.updated': ResearchRecord,
  'research.log.created': ResearchLog,
  'research.source.created': ResearchSource,
  'research.source.updated': ResearchSource,
  'research.snapshot.created': ResearchSnapshot,
  'research.excerpt.created': EvidenceExcerpt,
  'research.code.created': ResearchCode,
  'research.code.updated': ResearchCode,
  'research.coding.created': ResearchCoding,
  'research.finding.created': ResearchFinding,
  'research.finding.updated': ResearchFinding,
} as const;
