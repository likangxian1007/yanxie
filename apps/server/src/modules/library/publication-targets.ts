import { and, eq, or, isNull } from 'drizzle-orm';
import type { Paper, PaperPublicationTarget } from '@srh/shared';
import type { AppContext } from '../../context';
import { papers, paperPublications } from '../../db/schema';
import { getPaperRow, toPaper } from './service';
import type { QaTx } from './qa-records';

type PaperRow = typeof papers.$inferSelect;
export async function publicationTargets(tx: QaTx, source: PaperRow, projectId: string) {
  const receipts = await tx
    .select()
    .from(paperPublications)
    .where(
      and(
        eq(paperPublications.projectId, projectId),
        eq(paperPublications.sourcePaperId, source.id),
      ),
    );
  const priorIds = receipts.flatMap((r) => (r.paperId ? [r.paperId] : []));
  const identity = or(
    source.doi ? eq(papers.doi, source.doi) : undefined,
    source.arxivId ? eq(papers.arxivId, source.arxivId) : undefined,
    source.pdfSha256 ? eq(papers.pdfSha256, source.pdfSha256) : undefined,
    source.url ? eq(papers.url, source.url) : undefined,
    ...priorIds.map((id) => eq(papers.id, id)),
  );
  const rows = identity
    ? await tx
        .select()
        .from(papers)
        .where(
          and(
            eq(papers.projectId, projectId),
            eq(papers.space, 'team'),
            isNull(papers.ownerUserId),
            identity,
          ),
        )
    : [];
  return rows.map((p): PaperPublicationTarget<Paper> => {
    const history = receipts.filter((r) => r.paperId === p.id);
    const versions = (key: 'noteSelection' | 'annotationSelection' | 'qaSelection') =>
      history.flatMap((r) =>
        (JSON.parse(r[key]) as { id: string; version: number }[]).map(({ id, version }) => ({
          id,
          version,
        })),
      );
    return {
      paper: toPaper(p),
      reasons: [
        source.doi && source.doi === p.doi ? 'DOI 相同' : '',
        source.arxivId && source.arxivId === p.arxivId ? 'arXiv 编号相同' : '',
        source.pdfSha256 && source.pdfSha256 === p.pdfSha256 ? 'PDF 内容相同' : '',
        source.url && source.url === p.url ? '来源链接相同（需人工核对）' : '',
        priorIds.includes(p.id) ? '此前发布到此论文' : '',
      ].filter(Boolean),
      samePdf: Boolean(
        source.fileId && p.fileId && source.pdfSha256 && source.pdfSha256 === p.pdfSha256,
      ),
      published: {
        notes: versions('noteSelection'),
        annotations: versions('annotationSelection'),
        qa: versions('qaSelection'),
      },
    };
  });
}
export async function listPublicationTargets(
  ctx: AppContext,
  userId: string,
  paperId: string,
  projectId: string,
) {
  const source = await getPaperRow(ctx, { kind: 'personal', ownerUserId: userId }, paperId);
  return ctx.db.db.transaction((tx) => publicationTargets(tx, source, projectId));
}
