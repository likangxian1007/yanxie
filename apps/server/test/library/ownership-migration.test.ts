import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { newId, ulid } from '@srh/shared';
import { createDb } from '../../src/db/client';
import { migrationsFolder } from '../../src/db/migrate';
import { files, paperChunks, paperPublications, papers, shareLinks } from '../../src/db/schema';

it('L01 迁移保留旧项目的论文、PDF 路径与段落，不把旧论文转成私人资料', async () => {
  const folder = migrationsFolder();
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string; idx: number }[];
  };
  const target = journal.entries.findIndex((entry) =>
    entry.tag.endsWith('_library_account_collaboration'),
  );
  expect(target).toBeGreaterThan(0);
  const previous = await mkdtemp(join(tmpdir(), 'srh-l01-old-migrations-'));
  await mkdir(join(previous, 'meta'));
  const entries = journal.entries.slice(0, target);
  await writeFile(join(previous, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    await copyFile(join(folder, `${entry.tag}.sql`), join(previous, `${entry.tag}.sql`));
  }
  const db = await createDb('pglite:memory');
  try {
    await db.migrate(previous);
    const userId = newId('user');
    const projectId = newId('project');
    const fileId = newId('file');
    const paperId = `ppr_${ulid()}`;
    const actor = JSON.stringify({ kind: 'user', id: userId, name: '迁移测试用户' });
    // 按上游 0021 表结构插入，尚不存在账号个人库和独立阅读记录表。
    await db.db.execute(sql`insert into users (id,email,name,password_hash)
      values (${userId}, 'migration@example.test', '迁移测试用户', 'unused-test-hash')`);
    await db.db.execute(sql`insert into projects (id,name,created_by)
      values (${projectId}, '旧项目', ${userId})`);
    await db.db.execute(sql`insert into files (id,project_id,name,path,mime,size,uploaded_by)
      values (${fileId},${projectId},'legacy.pdf','library/legacy.pdf','application/pdf',123,${actor}::jsonb)`);
    await db.db
      .execute(sql`insert into papers (id,project_id,title,citekey,source,file_id,note,created_by)
      values (${paperId},${projectId},'旧论文','legacy2026','upload',${fileId},'旧团队笔记',${actor}::jsonb)`);
    await db.db
      .execute(sql`insert into paper_chunks (id,paper_id,project_id,seq,kind,page,para,text)
      values (${paperId + ':0'},${paperId},${projectId},0,'paragraph',1,1,'旧论文正文')`);
    const privateId = `ppr_${ulid()}`;
    await db.db
      .execute(sql`insert into papers (id,project_id,space,owner_user_id,title,citekey,source,private_pdf_path,created_by)
      values (${privateId},${projectId},'personal',${userId},'上游私人论文','private2026','upload','private/old.pdf',${actor}::jsonb)`);
    await db.db.insert(shareLinks).values({
      resourceKind: 'paper',
      resourceId: privateId,
      projectId,
      scope: 'project',
      level: 'view',
      token: 'migration-fixture-link',
      updatedBy: userId,
    });

    await db.migrate(folder);
    const [paper] = await db.db.select().from(papers).where(eq(papers.id, paperId));
    const [file] = await db.db.select().from(files).where(eq(files.id, fileId));
    const [chunk] = await db.db.select().from(paperChunks).where(eq(paperChunks.paperId, paperId));
    expect(paper).toMatchObject({
      projectId,
      ownerUserId: null,
      fileId,
      note: '旧团队笔记',
      titleVersion: 1,
      tagsVersion: 1,
    });
    expect(await db.db.select().from(paperPublications)).toEqual([]);
    expect(file).toMatchObject({ projectId, ownerUserId: null, path: 'library/legacy.pdf' });
    expect(chunk).toMatchObject({ projectId, paperId, text: '旧论文正文' });
    const [privatePaper] = await db.db.select().from(papers).where(eq(papers.id, privateId));
    expect(privatePaper).toMatchObject({
      projectId,
      ownerUserId: userId,
      space: 'personal',
      privatePdfPath: 'private/old.pdf',
      fileId: null,
    });
    expect(await db.db.select().from(shareLinks)).toMatchObject([
      { resourceId: privateId, scope: 'project', level: 'view', token: 'migration-fixture-link' },
    ]);
    await db.migrate(folder);
    expect(await db.db.select().from(papers)).toHaveLength(2);
  } finally {
    await db.close();
  }
}, 60_000);
