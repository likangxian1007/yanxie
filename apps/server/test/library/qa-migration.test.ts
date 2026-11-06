import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { it, expect } from 'vitest';
import { newId, ulid } from '@srh/shared';
import { createDb } from '../../src/db/client';
import { migrationsFolder } from '../../src/db/migrate';
import {
  papers,
  paperNotes,
  paperAnnotations,
  paperPublications,
  paperQaSessions,
  paperQaTurns,
} from '../../src/db/schema';
import { noteState } from '../../src/modules/library/notes';
it('整合迁移安装后，重复启动保留论文、笔记、标注与发布凭据', async () => {
  const folder = migrationsFolder(),
    journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
  const target = journal.entries.findIndex((e) => e.tag.endsWith('_library_account_collaboration'));
  expect(target).toBeGreaterThan(0);
  const previous = await mkdtemp(join(tmpdir(), 'srh-qa-migration-'));
  await mkdir(join(previous, 'meta'));
  const entries = journal.entries.slice(0, target + 1);
  await writeFile(join(previous, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const e of entries)
    await copyFile(join(folder, `${e.tag}.sql`), join(previous, `${e.tag}.sql`));
  const db = await createDb('pglite:memory');
  try {
    await db.migrate(previous);
    const uid = newId('user'),
      pid = newId('project'),
      paperId = `ppr_${ulid()}`,
      actor = { kind: 'user' as const, id: uid, name: '迁移用户' };
    await db.db.execute(
      sql`insert into users(id,email,name,password_hash) values(${uid},'qa-migration@example.test','迁移用户','unused')`,
    );
    await db.db.execute(
      sql`insert into projects(id,name,created_by) values(${pid},'原项目',${uid})`,
    );
    await db.db.insert(papers).values({
      id: paperId,
      ownerUserId: uid,
      citekey: 'legacy',
      title: '旧文献',
      source: 'doi',
      createdBy: actor,
    });
    await db.db.insert(paperNotes).values({
      id: `lnt_${ulid()}`,
      paperId,
      title: '旧笔记',
      body: '保留笔记',
      ydocState: noteState('保留笔记'),
      createdBy: actor,
      updatedBy: actor,
    });
    await db.db.insert(paperAnnotations).values({
      id: `lan_${ulid()}`,
      paperId,
      kind: 'comment',
      fileId: 'old-file',
      page: 1,
      quote: '原文',
      boxes: [],
      body: '保留批注',
      ydocState: noteState('保留批注'),
      createdBy: actor,
      updatedBy: actor,
    });
    await db.db.execute(
      sql`insert into paper_publications(id,publisher_user_id,request_id,project_id,source_paper_id,source_updated_at,published_by,annotation_selection) values('old-qa-receipt',${uid},'old-request',${pid},${paperId},now(),${JSON.stringify(actor)}::jsonb,'[]')`,
    );
    await db.migrate(folder);
    await db.migrate(folder);
    expect(await db.db.select().from(paperQaSessions)).toEqual([]);
    expect(await db.db.select().from(paperQaTurns)).toEqual([]);
    expect((await db.db.select().from(paperNotes))[0]?.body).toBe('保留笔记');
    expect((await db.db.select().from(paperAnnotations))[0]?.body).toBe('保留批注');
    expect((await db.db.select().from(paperPublications))[0]).toMatchObject({
      qaSelection: '[]',
      annotationSelection: '[]',
    });
  } finally {
    await db.close();
  }
}, 60000);
