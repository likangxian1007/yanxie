import { sql } from 'drizzle-orm';
import { jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import type { ActorRef } from '@srh/shared';

/** 主键：带前缀的 ULID（见 @srh/shared newId），应用层生成。 */
export const id = () => text('id').primaryKey();

/** 带时区时间戳，默认当前时间。 */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
export const ts = (name: string) => timestamp(name, { withTimezone: true });

/** 作者/操作者引用（人、agent、系统），冗余存展示名，避免每次 join。 */
export const actor = (name: string) => jsonb(name).$type<ActorRef>().notNull();

export const textArray = (name: string) =>
  text(name)
    .array()
    .notNull()
    .default(sql`'{}'::text[]`);

export const jsonObject = <T = Record<string, unknown>>(name: string) =>
  jsonb(name)
    .$type<T>()
    .notNull()
    .default(sql`'{}'::jsonb`);
