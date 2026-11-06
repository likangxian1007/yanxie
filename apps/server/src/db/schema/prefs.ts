import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { textArray, updatedAt } from './_helpers';
import { projects, users } from './core';

/**
 * 个人界面偏好里需要跟账号走的部分。归属：后端（modules/prefs）。
 * user_pins：某人在某项目里置顶的条目 id（线程 thr_…，以后也可放其他带前缀的 id），越靠前越新。
 */
export const userPins = pgTable(
  'user_pins',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ids: textArray('ids'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] })],
);
