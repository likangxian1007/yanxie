import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { migrationsFolder } from '../src/db/migrate';

const rows = (result: unknown) => (result as { rows: unknown[] }).rows;

it('升级已有研究记录时保留原有对象、历史和实验，不创建工作区条目', async () => {
  const root = await mkdtemp(join(tmpdir(), 'srh-workspace-migration-'));
  const current = migrationsFolder();
  const journal = JSON.parse(await readFile(join(current, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const index = journal.entries.findIndex((e) => e.tag.endsWith('_research_workspace'));
  expect(index).toBeGreaterThan(0);
  const old = { ...journal, entries: journal.entries.slice(0, index) };
  await mkdir(join(root, 'meta'));
  await writeFile(join(root, 'meta/_journal.json'), JSON.stringify(old));
  for (const entry of old.entries)
    await copyFile(join(current, `${entry.tag}.sql`), join(root, `${entry.tag}.sql`));
  const target = join(root, 'target');
  await mkdir(join(target, 'meta'), { recursive: true });
  const targetJournal = { ...journal, entries: journal.entries.slice(0, index + 1) };
  await writeFile(join(target, 'meta/_journal.json'), JSON.stringify(targetJournal));
  for (const entry of targetJournal.entries)
    await copyFile(join(current, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
  const db = await createDb('pglite:memory');
  try {
    await db.migrate(root);
    await db.db.execute(
      sql`insert into users (id,email,name,password_hash) values ('usr_old','old@example.test','旧用户','test')`,
    );
    await db.db.execute(
      sql`insert into projects (id,name,created_by) values ('prj_old','旧课题','usr_old')`,
    );
    await db.db.execute(
      sql`insert into research_entities (id,project_id,record_id,kind,version,data) values ('rrc_old','prj_old','rrc_old','record',2,'{"id":"rrc_old","question":"保留原问题","fieldValues":{"old":"历史值"}}'::jsonb)`,
    );
    await db.db.execute(
      sql`insert into research_revisions (id,project_id,record_id,version,data,created_by) values ('rrv_old','prj_old','rrc_old',1,'{"旧字段":"原文"}'::jsonb,'{"kind":"user","id":"usr_old","name":"旧用户"}'::jsonb)`,
    );
    await db.db.execute(
      sql`insert into experiments (id,project_id,title,created_by) values ('exp_old','prj_old','原实验','{"kind":"user","id":"usr_old","name":"旧用户"}'::jsonb)`,
    );
    const before = await db.db.execute(sql`select data from research_entities where id='rrc_old'`);
    const revBefore = await db.db.execute(
      sql`select data from research_revisions where id='rrv_old'`,
    );
    const expBefore = await db.db.execute(sql`select * from experiments where id='exp_old'`);
    await db.migrate(target);
    await db.migrate(target);
    expect(
      rows(await db.db.execute(sql`select data from research_entities where id='rrc_old'`)),
    ).toEqual(rows(before));
    expect(
      rows(await db.db.execute(sql`select data from research_revisions where id='rrv_old'`)),
    ).toEqual(rows(revBefore));
    expect(rows(await db.db.execute(sql`select * from experiments where id='exp_old'`))).toEqual(
      rows(expBefore),
    );
    expect(
      rows(
        await db.db.execute(sql`select count(*)::integer as count from research_workspace_items`),
      ),
    ).toEqual([{ count: 0 }]);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
