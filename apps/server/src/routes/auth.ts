import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '@supops/db';
import { db } from '../context.ts';
import { requireAuth, signToken, verifyPassword } from '../auth.ts';

export const authRoutes = Router();

const loginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

authRoutes.post('/login', (req, res) => {
  const parsed = loginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const user = db.select().from(users).where(eq(users.email, parsed.data.email)).get();
  // Same message and shape for "no such user" and "wrong password", so the endpoint
  // does not become a way to enumerate who has an account.
  const ok = user?.passwordHash && verifyPassword(parsed.data.password, user.passwordHash);
  if (!user || !ok || user.disabledAt) {
    res.status(401).json({ error: 'Incorrect email or password' });
    return;
  }

  const profile = { id: user.id, email: user.email, name: user.name, globalRole: user.globalRole };
  res.json({ token: signToken(profile), user: profile });
});

authRoutes.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
