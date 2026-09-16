import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULT_RUN_BUDGET, agents } from '@supops/db';
import { db, registry } from '../context.ts';

export const agentRoutes = Router();

agentRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  res.json(
    projectId
      ? db.select().from(agents).where(eq(agents.projectId, projectId)).all()
      : db.select().from(agents).all(),
  );
});

/** What an agent is allowed to be given. */
agentRoutes.get('/available-tools', (_req, res) => {
  res.json(
    registry.keys().map((key) => {
      const def = registry.get(key)!;
      return {
        key,
        description: def.description,
        baselineRisk: def.baselineRisk,
        targetKinds: def.targetKinds,
        mutating: def.mutating,
      };
    }),
  );
});

const createBody = z.object({
  projectId: z.string().min(1),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(60),
  systemPrompt: z.string().min(1).max(10_000),
  model: z.string().max(100).optional(),
  /**
   * null means "everything the project has enabled". Prefer an explicit short list:
   * tool-call accuracy degrades noticeably past roughly a dozen tools, and much
   * sooner on small local models.
   */
  toolKeys: z.array(z.string()).nullable().default(null),
});

agentRoutes.post('/', (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid agent' });
    return;
  }
  try {
    registry.resolve(parsed.data.toolKeys);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown tool' });
    return;
  }

  const row = db
    .insert(agents)
    .values({ ...parsed.data, budget: DEFAULT_RUN_BUDGET, createdAt: new Date() })
    .returning()
    .get();
  res.status(201).json(row);
});
