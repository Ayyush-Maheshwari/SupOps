import { eq } from 'drizzle-orm';
import {
  DEFAULT_RISK_POLICY,
  projects,
  users,
} from '@supops/db';
import { db } from './context.ts';
import { ensureBuiltinAgents } from './services/builtin-agents.ts';
import { config } from './config.ts';
import { emailDomainAllowed, hashPassword } from './auth.ts';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@supops.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'supops';

function seed() {
  // The bootstrap owner is created regardless of AUTH_ALLOWED_EMAIL_DOMAIN (you need a
  // way in), but flag when it is off-domain so operators set SEED_ADMIN_EMAIL properly.
  if (config.authAllowedDomains.length && !emailDomainAllowed(ADMIN_EMAIL)) {
    console.warn(
      `  ! Seed admin ${ADMIN_EMAIL} is not on the allowed domain(s) ` +
        `${config.authAllowedDomains.map((d) => '@' + d).join(', ')}. It is a local break-glass ` +
        `account; set SEED_ADMIN_EMAIL to an org address for the owner.`,
    );
  }

  let admin = db.select().from(users).where(eq(users.email, ADMIN_EMAIL)).get();
  if (!admin) {
    admin = db
      .insert(users)
      .values({
        email: ADMIN_EMAIL,
        name: 'Admin',
        passwordHash: hashPassword(ADMIN_PASSWORD),
        globalRole: 'owner',
        createdAt: new Date(),
      })
      .returning()
      .get();
    console.log(`  created user ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  }

  let project = db.select().from(projects).where(eq(projects.slug, 'default')).get();
  if (!project) {
    project = db
      .insert(projects)
      .values({
        slug: 'default',
        name: 'Default Project',
        description: 'Register your own targets here. Nothing is hardcoded.',
        riskPolicy: DEFAULT_RISK_POLICY,
        createdAt: new Date(),
      })
      .returning()
      .get();
    console.log('  created project "default"');
  }

  for (const slug of ensureBuiltinAgents(project.id)) console.log(`  created agent "${slug}"`);

  console.log('\n  Seed complete. Start the app with: npm run dev\n');
}

seed();
