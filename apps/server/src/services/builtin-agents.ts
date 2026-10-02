import { and, eq } from 'drizzle-orm';
import { DEFAULT_RUN_BUDGET, agents } from '@supops/db';
import { BUILTIN_TOOL_KEYS, CONSOLE_TOOL_KEYS } from '@supops/core';
import { db } from '../context.ts';

/**
 * The agents every project ships with. One definition, used when seeding, when a
 * project is created, and (later) when an admin resets an agent to its default --
 * it used to be copied in two places, which is how copies drift.
 *
 * The health-check agents are not here: they are created and kept in sync from
 * HEALTH_AGENT_SPECS (services/health.ts) the first time a scan runs.
 */
export const BUILTIN_AGENTS = [
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
] as const;

/**
 * Create any built-in agent the project is missing. Per agent, not "only if the
 * project has none", so a newly introduced built-in reaches existing installs.
 * Returns the slugs it created.
 */
export function ensureBuiltinAgents(projectId: string): string[] {
  const created: string[] = [];
  for (const a of BUILTIN_AGENTS) {
    const exists = db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.slug, a.slug)))
      .get();
    if (exists) continue;
    db.insert(agents)
      .values({ projectId, ...a, toolKeys: [...a.toolKeys], budget: DEFAULT_RUN_BUDGET, createdAt: new Date() })
      .run();
    created.push(a.slug);
  }
  return created;
}
