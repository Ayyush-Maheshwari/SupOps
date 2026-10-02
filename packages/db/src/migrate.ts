import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDb } from './client.ts';

const here = dirname(fileURLToPath(import.meta.url));
const path = process.env.DATABASE_PATH ?? join(here, '../../../data/supops.db');

const { db, sqlite } = createDb(path);
migrate(db, { migrationsFolder: join(here, '../migrations') });
sqlite.close();
console.log(`migrated ${path}`);
