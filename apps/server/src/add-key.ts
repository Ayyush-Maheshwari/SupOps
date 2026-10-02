/**
 * Attach an SSH private key to a target by reading the file directly.
 *
 * Pasting a key into a browser textarea is where they get mangled -- a partial
 * selection silently drops the `-----BEGIN-----` armor, and the result authenticates
 * as a password and fails with a message that points nowhere near the cause. Reading
 * the file removes that whole class of problem.
 *
 *   npm run add-key -- <target-slug> <path-to-key>
 */
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import {
  credentials,
  encryptSecret,
  fingerprintSecret,
  packEnvelope,
  targets,
} from '@supops/db';
import { diagnoseSecret } from '@supops/core';
import { db } from './context.ts';

const [slug, path] = process.argv.slice(2);

if (!slug || !path) {
  console.error('\n  usage: npm run add-key -- <target-slug> <path-to-key>\n');
  process.exit(1);
}

const target = db.select().from(targets).where(eq(targets.slug, slug)).get();
if (!target) {
  const known = db.select({ slug: targets.slug }).from(targets).all().map((t) => t.slug);
  console.error(`\n  No target "${slug}". Known targets: ${known.join(', ') || '(none)'}\n`);
  process.exit(1);
}

let key: string;
try {
  key = readFileSync(path.replace(/^~/, process.env.HOME ?? '~'), 'utf8');
} catch (err) {
  console.error(`\n  Could not read ${path}: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}

const { kind, problem } = diagnoseSecret(key);
if (problem) {
  console.error(`\n  ${path} does not look usable:\n  ${problem}\n`);
  process.exit(1);
}
if (kind !== 'private_key') {
  console.error(`\n  ${path} does not look like a private key.\n`);
  process.exit(1);
}

const cred = db
  .insert(credentials)
  .values({
    projectId: target.projectId,
    name: `${target.slug} key`,
    type: 'ssh_key',
    secretEnc: packEnvelope(encryptSecret(key)),
    fingerprint: fingerprintSecret(key),
    createdAt: new Date(),
  })
  .returning()
  .get();

db.update(targets)
  .set({ credentialId: cred.id, healthState: 'unknown', lastCheckedAt: null })
  .where(eq(targets.id, target.id))
  .run();

const cfg = target.config as { user?: string; host?: string; port?: number };
console.log(`\n  Attached ${path} to "${target.slug}" (${cfg.user}@${cfg.host}:${cfg.port}).`);
console.log('  Encrypted at rest. Run "Test" on the Targets page to confirm it works.\n');
