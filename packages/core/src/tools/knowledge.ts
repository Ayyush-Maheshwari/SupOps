import { z } from 'zod';
import { TARGET_KINDS } from '@supops/shared';
import type { RiskContribution } from '@supops/shared';
import type { ToolDef } from './types.ts';
import { errOutput, okOutput } from './output.ts';

/**
 * The project's approved knowledge, on demand. The opening message gives pinned facts,
 * the best text matches and an index of every other document; these let the agent read
 * whichever of them fit the problem, rather than relying on what was matched for it.
 *
 * Read-only, and only approved documents in the run's scope -- the engine supplies the
 * accessor (ExecContext.knowledge), so a tool cannot reach another project's or a
 * draft's text. What a document says is operator-written guidance, never authority:
 * the risk engine still rules on every action it suggests.
 */

const READ: RiskContribution[] = [{ stage: 'arguments', tier: 'read_only', ruleId: 'knowledge.read', reason: 'reads the project\'s approved knowledge' }];
const BODY_CHARS = 16_000;

const searchArgs = z.object({
  target: z.string(),
  query: z.string().min(2).max(300),
});

export const searchKnowledgeTool: ToolDef<z.infer<typeof searchArgs>> = {
  key: 'search_knowledge',
  kind: 'knowledge',
  description:
    'Search the project\'s approved runbooks, notes and facts by keywords (service, symptom, error text). ' +
    'Returns titles, slugs and a snippet; read one in full with read_knowledge. The target argument is ignored.',
  parameters: {
    query: { type: 'string', description: 'Keywords, e.g. "postgres replication lag" or "disk full journald".' },
  },
  required: ['query'],
  argsSchema: searchArgs,
  baselineRisk: 'read_only',
  targetKinds: [...TARGET_KINDS],
  mutating: false,
  timeoutMs: 5_000,
  render: (a) => `search_knowledge "${a.query}"`,
  classifyArgs: () => READ,
  execute: async (a, ctx) => {
    if (!ctx.knowledge) return errOutput('Project knowledge is not available in this run.');
    const hits = ctx.knowledge.search(a.query);
    if (!hits.length) return okOutput(`No approved documents match "${a.query}". Try other words, or proceed without.`);
    return okOutput(hits.map((h) => `- ${h.title} [${h.slug}, ${h.kind}]: ${h.snippet}`).join('\n'));
  },
};

const readArgs = z.object({
  target: z.string(),
  slug: z.string().min(1).max(80),
});

export const readKnowledgeTool: ToolDef<z.infer<typeof readArgs>> = {
  key: 'read_knowledge',
  kind: 'knowledge',
  description:
    'Read one of the project\'s approved runbooks, notes or facts in full, by its slug (shown in brackets in the ' +
    'knowledge index and in search_knowledge results). Read a runbook before acting on its subject, and follow its ' +
    'steps, saying where you deviate. The target argument is ignored.',
  parameters: {
    slug: { type: 'string', description: 'The document slug, e.g. disk-full-web.' },
  },
  required: ['slug'],
  argsSchema: readArgs,
  baselineRisk: 'read_only',
  targetKinds: [...TARGET_KINDS],
  mutating: false,
  timeoutMs: 5_000,
  render: (a) => `read_knowledge ${a.slug}`,
  classifyArgs: () => READ,
  execute: async (a, ctx) => {
    if (!ctx.knowledge) return errOutput('Project knowledge is not available in this run.');
    const d = ctx.knowledge.read(a.slug);
    if (!d) return errOutput(`No approved document with the slug "${a.slug}" in this run's scope. Use search_knowledge to find the right slug.`);
    const body = d.body.length > BODY_CHARS ? `${d.body.slice(0, BODY_CHARS)}\n… (truncated)` : d.body;
    return okOutput(`${d.title} [${d.slug}, ${d.kind}]${d.source ? ` (from ${d.source})` : ''}\n\n${body}`);
  },
};
