import { Router } from 'express';
import { z } from 'zod';
import { LLMClient } from '@supops/core';
import { applyLlmSettings, llm, registry, settingsStore } from '../context.ts';

export const settingsRoutes = Router();

settingsRoutes.get('/llm', (_req, res) => {
  res.json(settingsStore.public());
});

const patchBody = z.object({
  baseUrl: z.string().url('Enter a full URL, e.g. http://localhost:11434/v1/').optional(),
  model: z.string().min(1).max(120).optional(),
  classifierModel: z.string().max(120).optional(),
  runConcurrency: z.number().int().min(1).max(20).optional(),
  /**
   * Omit to leave the stored key untouched -- the UI cannot display it, so it must
   * be able to save the other fields without clearing it. Send "" to clear it.
   */
  apiKey: z.string().max(400).optional(),
});

settingsRoutes.put('/llm', (req, res) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' });
    return;
  }

  const saved = settingsStore.save(parsed.data);
  applyLlmSettings();
  res.json(saved);
});

const testBody = patchBody.partial();

/**
 * Check a provider without committing to it.
 *
 * Any fields supplied here are tested instead of the saved ones, so an operator can
 * confirm a key or a local endpoint actually works before saving it -- rather than
 * saving a broken config and discovering it during an incident.
 */
settingsRoutes.post('/llm/test', async (req, res) => {
  const parsed = testBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, detail: parsed.error.issues[0]?.message ?? 'Invalid settings' });
    return;
  }

  const overrides = parsed.data;
  const hasOverride = Object.values(overrides).some((v) => v !== undefined && v !== '');

  const client = hasOverride
    ? new LLMClient({ ...settingsStore.resolve(), ...stripEmpty(overrides) })
    : llm;

  const result = await client.ping();
  res.json({ ...result, model: client.config.model, baseUrl: client.config.baseUrl });
});

settingsRoutes.get('/tools', (_req, res) => {
  res.json(
    registry.keys().map((key) => {
      const def = registry.get(key)!;
      return {
        key,
        description: def.description,
        baselineRisk: def.baselineRisk,
        mutating: def.mutating,
      };
    }),
  );
});

/** An empty string means "clear" when saving, but "use the saved value" when testing. */
function stripEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''),
  ) as Partial<T>;
}
