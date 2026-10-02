import { integer, text } from 'drizzle-orm/sqlite-core';
import { nanoid } from 'nanoid';

export const id = () => text('id').primaryKey().$defaultFn(() => nanoid());
export const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
export const createdAt = () =>
  ts('created_at').notNull().$defaultFn(() => new Date());
