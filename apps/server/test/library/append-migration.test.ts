import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { it, expect } from 'vitest';
import { createDb } from '../../src/db/client';
import { migrationsFolder } from '../../src/db/migrate';
import { papers, paperQaTurns, paperPublications } from '../../src/db/schema';

it('整合迁移安装后，发布凭据与问答获得兼容默认值，重复启动不丢数据', async () => {
  const folder = migrationsFolder(),
    journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
  const target = journal.entries.findIndex((e) => e.tag.endsWith('_library_account_collaboration'));
  expect(target).toBeGreaterThan(0);
  const before = await mkdtemp(join(tmpdir(), 'srh-append-migration-'));
  await mkdir(join(before, 'meta'));
  const entries = journal.entries.slice(0, target + 1);
  await writeFile(join(before, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const e of entries)
    await copyFile(join(folder, `${e.tag}.sql`), join(before, `${e.tag}.sql`));
  const db = await createDb('pglite:memory');
  try {
    await db.migrate(before);
    const actor = { kind: 'user' as const, id: 'usr_old', name: '原作者' };
    await db.db.execute(
      sql`insert into users(id,email,name,password_hash) values('usr_old','old@example.test','原作者','unused')`,
    );
    await db.db.execute(
      sql`insert into projects(id,name,created_by) values('prj_old','旧项目','usr_old')`,
    );
    await db.db.insert(papers).values({
      id: 'ppr_old',
      ownerUserId: 'usr_old',
      title: '旧论文',
      citekey: 'old',
      source: 'doi',
      createdBy: actor,
    });
    const a = JSON.stringify(actor);
    await db.db.execute(
      sql`insert into paper_publications(id,publisher_user_id,request_id,project_id,source_paper_id,source_updated_at,published_by,qa_selection) values('pub_old','usr_old','old-request','prj_old','ppr_old',now(),${a}::jsonb,'[{"id":"lqt_old","version":1}]')`,
    );
    await db.db.execute(
      sql`insert into paper_qa_sessions(id,paper_id,title,created_by,updated_by) values('lqs_old','ppr_old','旧会话',${a}::jsonb,${a}::jsonb)`,
    );
    await db.db.execute(
      sql`insert into paper_qa_turns(id,session_id,paper_id,generation_id,request_id,request_signature,requested_by_user_id,question,original_question,answer,original_answer,status,model_name,created_by,updated_by) values('lqt_old','lqs_old','ppr_old','lqj_old','old-request','signature','usr_old','原问题','原问题','保留答案','保留答案','done','原模型',${a}::jsonb,${a}::jsonb)`,
    );
    await db.migrate(folder);
    await db.migrate(folder);
    expect((await db.db.select().from(paperQaTurns))[0]).toMatchObject({
      answer: '保留答案',
      selection: null,
    });
    expect((await db.db.select().from(paperPublications))[0]).toMatchObject({
      requestOptions: '{}',
      summary: null,
      qaSelection: '[{"id":"lqt_old","version":1}]',
    });
  } finally {
    await db.close();
  }
}, 60000);
