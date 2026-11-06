import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { migrationsFolder } from '../src/db/migrate';

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
  [key: string]: unknown;
}

describe('research migration on isolated databases', () => {
  it('upgrades populated pre-research data without changing old identities or copying experiments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'srh-upgrade-'));
    const current = migrationsFolder();
    const journal = JSON.parse(
      await readFile(join(current, 'meta/_journal.json'), 'utf8'),
    ) as Journal;
    const researchIndex = journal.entries.findIndex((entry) => entry.tag.endsWith('_research'));
    expect(researchIndex).toBeGreaterThan(0);
    const old = { ...journal, entries: journal.entries.slice(0, researchIndex) };
    await mkdir(join(root, 'meta'));
    await writeFile(join(root, 'meta/_journal.json'), JSON.stringify(old));
    for (const entry of old.entries)
      await copyFile(join(current, `${entry.tag}.sql`), join(root, `${entry.tag}.sql`));
    const target = join(root, 'target');
    await mkdir(join(target, 'meta'), { recursive: true });
    const targetJournal = { ...journal, entries: journal.entries.slice(0, researchIndex + 1) };
    await writeFile(join(target, 'meta/_journal.json'), JSON.stringify(targetJournal));
    for (const entry of targetJournal.entries)
      await copyFile(join(current, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
    const db = await createDb('pglite:memory');
    try {
      await db.migrate(root);
      await db.db.execute(
        sql`insert into users (id,email,name,password_hash) values ('usr_migration','migration@example.test','旧用户','not-a-login')`,
      );
      await db.db.execute(
        sql`insert into projects (id,name,created_by) values ('prj_migration','旧课题','usr_migration')`,
      );
      await db.db.execute(
        sql`insert into project_members (project_id,user_id,role) values ('prj_migration','usr_migration','owner')`,
      );
      // 旧记录保留无数值指标的实地观察，不猜测其研究方法。
      await db.db.execute(
        sql`insert into experiments (id,project_id,title,hypothesis,created_by) values ('exp_migration','prj_migration','旧实地观察','', '{"kind":"user","id":"usr_migration","name":"旧用户"}'::jsonb)`,
      );
      const before = await db.db.execute(sql`select * from experiments where id='exp_migration'`);
      await db.migrate(target);
      await db.migrate(target);
      const after = await db.db.execute(sql`select * from experiments where id='exp_migration'`);
      expect((after as { rows: unknown[] }).rows).toEqual((before as { rows: unknown[] }).rows);
      const records = await db.db.execute(
        sql`select count(*)::integer as count from research_entities`,
      );
      expect((records as { rows: unknown[] }).rows).toEqual([{ count: 0 }]);
      const projects = await db.db.execute(
        sql`select id,name from projects where id='prj_migration'`,
      );
      expect((projects as { rows: unknown[] }).rows).toEqual([
        { id: 'prj_migration', name: '旧课题' },
      ]);
    } finally {
      await db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
