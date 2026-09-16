import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_RISK_POLICY,
  DEFAULT_RUN_BUDGET,
  agents,
  projects,
  users,
} from '@supops/db';
import { BUILTIN_TOOL_KEYS, CONSOLE_TOOL_KEYS } from '@supops/core';
import { db } from './context.ts';
import { hashPassword } from './auth.ts';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@supops.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'supops';

function seed() {
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

  /**
   * Seeded per agent rather than "only if the project has none" -- otherwise adding a
   * new built-in agent never reaches an existing install, which is exactly what
   * happened when the Console agent was introduced.
   */
  const AGENTS = [
    {
      slug: 'triage',
      name: 'Triage Agent',
      role: 'triage',
      toolKeys: BUILTIN_TOOL_KEYS,
      systemPrompt:
        'You are triaging an incident. Work the problem from evidence: check service ' +
        'status, recent logs, resource pressure and recent changes before forming a ' +
        'hypothesis. State your conclusion with record_finding before proposing any ' +
        'change. Prefer the smallest reversible action that addresses the cause.',
    },
    {
      slug: 'console',
      name: 'Console Assistant',
      role: 'assistant',
      toolKeys: CONSOLE_TOOL_KEYS,
      systemPrompt:
        'You are an operations assistant working alongside an engineer. Unlike an ' +
        'incident triage run, most of what you are asked is ordinary work: check ' +
        'something, make something, or explain something.\n\n' +
        'If a question can be answered without touching a machine, just answer it -- do ' +
        'not invent a command to look busy. If it needs a machine, run the narrowest ' +
        'command that answers it and say what you found in plain language.\n\n' +
        'Keep replies short. The engineer can see every command and its output beside ' +
        'this conversation, so do not repeat output back at them -- interpret it. Ask a ' +
        'clarifying question when the request is ambiguous rather than guessing at ' +
        'something destructive.',
    },
    // The health-check agents (healthcheck / healthcheck-quick) are not seeded here:
    // they are created and kept in sync from HEALTH_AGENT_SPECS the first time a scan
    // runs, so a single definition covers every project, new or existing.
  ];

  for (const a of AGENTS) {
    const exists = db
      .select()
      .from(agents)
      .where(and(eq(agents.projectId, project.id), eq(agents.slug, a.slug)))
      .get();
    if (exists) continue;

    db.insert(agents)
      .values({ projectId: project.id, ...a, budget: DEFAULT_RUN_BUDGET, createdAt: new Date() })
      .run();
    console.log(`  created agent "${a.slug}"`);
  }

  console.log('\n  Seed complete. Start the app with: npm run dev\n');
}

seed();
