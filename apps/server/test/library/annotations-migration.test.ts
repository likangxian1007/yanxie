import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { newId, ulid } from '@srh/shared';
import { createDb } from '../../src/db/client';
import { migrationsFolder } from '../../src/db/migrate';
import { paperAnnotations, paperNotes, paperPublications, papers } from '../../src/db/schema';
import { noteState } from '../../src/modules/library/notes';

it('整合迁移安装后，重复启动保留个人论文、独立笔记和发布凭据', async () => {
  const folder = migrationsFolder();
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const target = journal.entries.findIndex((entry) =>
    entry.tag.endsWith('_library_account_collaboration'),
  );
  expect(target).toBeGreaterThan(0);
  const previous = await mkdtemp(join(tmpdir(), 'srh-annotations-migrations-'));
  await mkdir(join(previous, 'meta'));
  const entries = journal.entries.slice(0, target + 1);
  await writeFile(join(previous, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries)
    await copyFile(join(folder, `${entry.tag}.sql`), join(previous, `${entry.tag}.sql`));
  const db = await createDb('pglite:memory');
  try {
    await db.migrate(previous);
    const uid = newId('user'),
      pid = newId('project'),
      paperId = `ppr_${ulid()}`,
      noteId = `lnt_${ulid()}`;
    const actor = { kind: 'user' as const, id: uid, name: '迁移用户' };
    await db.db.execute(
      sql`insert into users (id,email,name,password_hash) values (${uid},'annotations-migration@example.test','迁移用户','unused-test-hash')`,
    );
    await db.db.execute(
      sql`insert into projects (id,name,created_by) values (${pid},'原有项目',${uid})`,
    );
    await db.db.insert(papers).values({
      id: paperId,
      ownerUserId: uid,
      citekey: 'legacy',
      title: '个人论文',
      source: 'doi',
      note: '原来的旧笔记',
      createdBy: actor,
    });
    await db.db.insert(paperNotes).values({
      id: noteId,
      paperId,
      title: '已有独立笔记',
      body: '保留此内容',
      ydocState: noteState('保留此内容'),
      createdBy: actor,
      updatedBy: actor,
    });
    await db.db.execute(
      sql`insert into paper_publications (id,publisher_user_id,request_id,project_id,source_paper_id,source_updated_at,published_by,note_selection) values ('old_receipt',${uid},'old_request',${pid},${paperId},now(),${JSON.stringify(actor)}::jsonb,'[]')`,
    );
    await db.migrate(folder);
    expect(await db.db.select().from(paperAnnotations)).toEqual([]);
    expect((await db.db.select().from(papers).where(eq(papers.id, paperId)))[0]).toMatchObject({
      ownerUserId: uid,
      projectId: null,
      note: '原来的旧笔记',
    });
    expect((await db.db.select().from(paperNotes))[0]).toMatchObject({
      id: noteId,
      body: '保留此内容',
    });
    expect((await db.db.select().from(paperPublications))[0]).toMatchObject({
      id: 'old_receipt',
      annotationSelection: '[]',
      noteSelection: '[]',
    });
    await db.migrate(folder);
    expect(await db.db.select().from(paperNotes)).toHaveLength(1);
    expect(await db.db.select().from(paperPublications)).toHaveLength(1);
  } finally {
    await db.close();
  }
}, 60000);
