import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { WebClient } from '@slack/web-api';
import { alertSubscriptions } from '@supops/db';
import { db } from '../context.ts';
import {
  publicSlackSettings,
  resolveSlackSettings,
  saveSlackSettings,
} from '../slack/settings.ts';
import { slackListener } from '../slack/listener.ts';

export const integrationRoutes = Router();

// ---- Slack connection (workspace-level) ------------------------------------

integrationRoutes.get('/slack', (_req, res) => {
  res.json({ ...publicSlackSettings(), connected: slackListener.isConnected() });
});

const slackBody = z.object({
  appToken: z.string().optional(),
  botToken: z.string().optional(),
  enabled: z.boolean().optional(),
});

integrationRoutes.put('/slack', async (req, res) => {
  const parsed = slackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid Slack settings' });
    return;
  }
  const result = saveSlackSettings(parsed.data);
  // Apply live: reconnect (or disconnect) the socket to match the new config.
  await slackListener.reload();
  res.json({ ...result, connected: slackListener.isConnected() });
});

/** Validate the stored bot token against Slack, without revealing it. */
integrationRoutes.post('/slack/test', async (_req, res) => {
  const { botToken } = resolveSlackSettings();
  if (!botToken) {
    res.status(400).json({ ok: false, error: 'No bot token is configured.' });
    return;
  }
  try {
    const auth = await new WebClient(botToken).auth.test();
    res.json({ ok: true, team: auth.team, botId: auth.user });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Auth test failed' });
  }
});

/** Channels the bot can see -- the pick-list for subscriptions. */
integrationRoutes.get('/slack/channels', async (_req, res) => {
  const { botToken } = resolveSlackSettings();
  if (!botToken) {
    res.status(400).json({ error: 'No bot token is configured.' });
    return;
  }
  try {
    const web = new WebClient(botToken);
    const list = await web.conversations.list({ types: 'public_channel,private_channel', limit: 200 });
    const channels = (list.channels ?? [])
      .filter((c) => c.is_member)
      .map((c) => ({ id: c.id, name: c.name ? `#${c.name}` : c.id }));
    res.json(channels);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not list channels' });
  }
});

// ---- Per-project channel subscriptions (routing) ---------------------------

integrationRoutes.get('/slack/subscriptions', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  res.json(db.select().from(alertSubscriptions).where(eq(alertSubscriptions.projectId, projectId)).all());
});

const subBody = z.object({
  projectId: z.string().min(1),
  channelId: z.string().min(1),
  channelName: z.string().min(1),
});

/** Subscribe a project to a channel (idempotent). */
integrationRoutes.post('/slack/subscriptions', (req, res) => {
  const parsed = subBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'projectId, channelId and channelName are required' });
    return;
  }
  const { projectId, channelId, channelName } = parsed.data;
  const existing = db
    .select()
    .from(alertSubscriptions)
    .where(and(eq(alertSubscriptions.projectId, projectId), eq(alertSubscriptions.channelId, channelId)))
    .get();
  if (existing) {
    const row = db
      .update(alertSubscriptions)
      .set({ enabled: true, channelName })
      .where(eq(alertSubscriptions.id, existing.id))
      .returning()
      .get();
    res.status(200).json(row);
    return;
  }
  const row = db.insert(alertSubscriptions).values({ projectId, channelId, channelName }).returning().get();
  res.status(201).json(row);
});

integrationRoutes.delete('/slack/subscriptions/:id', (req, res) => {
  const removed = db.delete(alertSubscriptions).where(eq(alertSubscriptions.id, req.params.id)).returning().get();
  if (!removed) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }
  res.json({ ok: true });
});
