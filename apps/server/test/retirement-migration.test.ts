import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { migrationsFolder } from '../src/db/migrate';
const rows = (result: unknown) => (result as { rows: unknown[] }).rows;
it('旧数据升级：移除实验专属内容，保留独立与研究空间引用的 Notebook 和证据原文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'srh-retirement-'));
  const current = migrationsFolder();
  const journal = JSON.parse(await readFile(join(current, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const index = journal.entries.findIndex((e) => e.tag.endsWith('_retire_feature_data'));
  expect(index).toBeGreaterThan(0);
  const old = { ...journal, entries: journal.entries.slice(0, index) };
  await mkdir(join(root, 'meta'));
  await writeFile(join(root, 'meta/_journal.json'), JSON.stringify(old));
  for (const entry of old.entries)
    await copyFile(join(current, `${entry.tag}.sql`), join(root, `${entry.tag}.sql`));
  const db = await createDb('pglite:memory');
  try {
    await db.migrate(root);
    await db.db.execute(
      sql`insert into users(id,email,name,password_hash) values('usr_old','old@example.test','旧用户','test')`,
    );
    await db.db.execute(
      sql`insert into projects(id,name,created_by,preferred_research_methods) values('prj_old','原课题','usr_old',ARRAY['computational'])`,
    );
    await db.db.execute(
      sql`insert into experiments(id,project_id,title,created_by) values('exp_old','prj_old','旧实验','{"kind":"user","id":"usr_old","name":"旧用户"}'::jsonb)`,
    );
    await db.db.execute(
      sql`insert into experiment_logs(id,experiment_id,author,body) values('elg_old','exp_old','{"kind":"user","id":"usr_old","name":"旧用户"}'::jsonb,'旧日志')`,
    );
    await db.db.execute(
      sql`insert into notebooks(id,project_id,experiment_id,title,created_by,ydoc_state) select id,'prj_old',case when id='nb_independent' then null else 'exp_old' end,id,'{"kind":"user","id":"usr_old","name":"旧用户"}'::jsonb,decode('000102','hex') from unnest(ARRAY['nb_exclusive','nb_shared','nb_historical','nb_independent']) id`,
    );
    await db.db.execute(
      sql`insert into research_entities(id,project_id,kind,version,data) values('rsr_old','prj_old','source',1,'{"kind":"notebook","resourceId":"nb_shared","title":"保留材料"}'::jsonb)`,
    );
    await db.db.execute(
      sql`insert into research_revisions(id,project_id,record_id,version,data,created_by) values('rrv_old','prj_old','rrc_old',1,'{"resources":[{"kind":"notebook","id":"nb_historical"}],"evidence":"原始证据"}'::jsonb,'{"kind":"user","id":"usr_old","name":"旧用户"}'::jsonb)`,
    );
    await db.db.execute(
      sql`insert into messages(id,project_id,author_kind,author_name,body) values('msg_old','prj_old','user','旧用户','原消息 #exp_old')`,
    );
    const before = rows(
      await db.db.execute(sql`select data from research_revisions where id='rrv_old'`),
    );
    await db.migrate(current);
    await db.migrate(current);
    expect(rows(await db.db.execute(sql`select id from notebooks order by id`))).toEqual([
      { id: 'nb_historical' },
      { id: 'nb_independent' },
      { id: 'nb_shared' },
    ]);
    expect(
      rows(
        await db.db.execute(
          sql`select encode(ydoc_state,'hex') as content from notebooks where id='nb_shared'`,
        ),
      ),
    ).toEqual([{ content: '000102' }]);
    expect(
      rows(await db.db.execute(sql`select data from research_revisions where id='rrv_old'`)),
    ).toEqual(before);
    expect(rows(await db.db.execute(sql`select body from messages where id='msg_old'`))).toEqual([
      { body: '原消息 #exp_old' },
    ]);
    expect(
      rows(
        await db.db.execute(
          sql`select to_regclass('experiments') as experiments,to_regclass('experiment_logs') as logs`,
        ),
      ),
    ).toEqual([{ experiments: null, logs: null }]);
    expect(
      rows(
        await db.db.execute(
          sql`select column_name from information_schema.columns where table_name in ('notebooks','cards','projects') and column_name in ('experiment_id','preferred_research_methods')`,
        ),
      ),
    ).toEqual([]);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
