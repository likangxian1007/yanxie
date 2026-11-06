import type { FastifyInstance } from 'fastify';
import type { ProjectRole } from '@srh/shared';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createDb, type DbHandle } from '../../src/db/client';
import { migrationsFolder } from '../../src/db/migrate';
import { projectMembers, projects, users, versioningSettings } from '../../src/db/schema';
import type { AccessPolicy, RealtimeUser } from '../../src/realtime/access';

/**
 * 协作模块测试脚手架：内存 PGlite + 以请求头 `x-test-user` 识别身份的访问策略。
 *
 *   const t = await setupCollabApp();
 *   await t.seedUser('usr_a', '张三'); await t.addMember('prj_t', 'usr_a', 'member');
 *   const res = await t.app.inject({ method: 'GET', url: '/api/v1/projects/prj_t/docs', headers: t.as('usr_a') });
 */
export interface CollabTestApp {
  app: FastifyInstance;
  db: DbHandle;
  /** 以某个用户身份发请求的请求头 */
  as(userId: string): Record<string, string>;
  seedUser(id: string, name: string, avatarColor?: number): Promise<void>;
  seedProject(id: string, ownerId: string): Promise<void>;
  addMember(projectId: string, userId: string, role: ProjectRole): Promise<void>;
  /** 版本设置「agent 直接写入」：测 agent 实时编辑的用例用（默认 agent 的修改会变成改动提案） */
  allowAgentDirectWrite(projectId: string): Promise<void>;
  close(): Promise<void>;
}

export async function setupCollabApp(env: Record<string, string> = {}): Promise<CollabTestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    LOG_LEVEL: 'silent',
    LLM_API_KEY: '',
    STORAGE_DIR: '.data/test-storage',
    ...env,
  });
  const db = await createDb(config.DATABASE_URL);
  await db.migrate(migrationsFolder());

  const names = new Map<string, RealtimeUser>();
  const access: AccessPolicy = {
    async userFromRequest(req) {
      const id = req.headers['x-test-user'];
      if (typeof id !== 'string') {
        // WebSocket 握手：也接受 ?testUser=
        const q = (req.query as Record<string, string> | undefined)?.testUser;
        return q ? (names.get(q) ?? null) : null;
      }
      return names.get(id) ?? null;
    },
    async canAccessProject() {
      return true;
    },
    canSeeEvent() {
      return true;
    },
  };

  const app = await buildApp({ config, db, logger: false, access });
  await app.ready();

  return {
    app,
    db,
    as: (userId) => ({ 'x-test-user': userId }),
    async seedUser(id, name, avatarColor = 0) {
      names.set(id, { id, name, avatarColor });
      await db.db
        .insert(users)
        .values({ id, email: `${id}@example.com`, name, passwordHash: 'x', avatarColor })
        .onConflictDoNothing();
    },
    async seedProject(id, ownerId) {
      await db.db.insert(projects).values({ id, name: '测试课题', createdBy: ownerId });
      await db.db.insert(projectMembers).values({ projectId: id, userId: ownerId, role: 'owner' });
    },
    async addMember(projectId, userId, role) {
      await db.db.insert(projectMembers).values({ projectId, userId, role }).onConflictDoNothing();
    },
    async allowAgentDirectWrite(projectId) {
      await db.db
        .insert(versioningSettings)
        .values({ projectId, agentDirectWrite: true })
        .onConflictDoUpdate({
          target: versioningSettings.projectId,
          set: { agentDirectWrite: true },
        });
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
}
