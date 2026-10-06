import { Router } from 'express';
import { z } from 'zod';
import { KNOWLEDGE_TOOL_KEYS, LLMClient } from '@supops/core';
import { applyLlmSettings, llm, registry, settingsStore } from '../context.ts';
import { isAdmin } from '../auth.ts';
import { audit } from '../services/audit.ts';

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
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can change the model provider.' });
    return;
  }
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' });
    return;
  }

  const saved = settingsStore.save(parsed.data);
  applyLlmSettings();
  // Never write the key itself into the log -- only that it changed.
  const { apiKey, ...changed } = parsed.data as Record<string, unknown>;
  audit(req.user, { entity: 'settings.llm', action: 'update', after: { ...changed, ...(apiKey !== undefined ? { apiKeyChanged: true } : {}) } });
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
    // The knowledge tools are given to every run automatically, so they are not a choice.
    registry.keys().filter((key) => !KNOWLEDGE_TOOL_KEYS.includes(key)).map((key) => {
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
