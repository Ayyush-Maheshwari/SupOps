import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.DATABASE_PATH ?? '../../data/supops.db' },
} satisfies Config;
