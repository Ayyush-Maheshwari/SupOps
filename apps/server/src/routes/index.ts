import { Router } from 'express';
import { requireAuth } from '../auth.ts';
import { authRoutes } from './auth.ts';
import { projectRoutes } from './projects.ts';
import { targetRoutes } from './targets.ts';
import { agentRoutes } from './agents.ts';
import { dashboardRoutes } from './dashboard.ts';
import { runRoutes } from './runs.ts';
import { settingsRoutes } from './settings.ts';
import { alertRoutes } from './alerts.ts';
import { healthRoutes } from './health.ts';
import { userRoutes } from './users.ts';
import { integrationRoutes } from './integrations.ts';

export const api = Router();

api.get('/health', (_req, res) => res.json({ ok: true }));
api.use('/auth', authRoutes);

// Everything past this point needs a session.
api.use(requireAuth);
api.use('/projects', projectRoutes);
api.use('/targets', targetRoutes);
api.use('/agents', agentRoutes);
api.use('/runs', runRoutes);
api.use('/dashboard', dashboardRoutes);
api.use('/settings', settingsRoutes);
api.use('/alerts', alertRoutes);
api.use('/health', healthRoutes);
api.use('/users', userRoutes);
api.use('/integrations', integrationRoutes);
