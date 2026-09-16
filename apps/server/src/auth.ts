import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.ts';

/**
 * scrypt rather than argon2: argon2 needs a native build, and this machine (like
 * plenty of deployment targets) has no compiler. scrypt is in Node's standard
 * library, is memory-hard, and is a perfectly respectable choice here.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(expected, actual);
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  globalRole: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const signToken = (user: AuthUser): string =>
  jwt.sign(user, config.jwtSecret, { expiresIn: '24h' });

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  try {
    req.user = jwt.verify(token, config.jwtSecret) as AuthUser;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired; sign in again' });
  }
}

/** The admin tier for account management. `owner` and `admin` are equivalent here. */
export const ADMIN_ROLES = ['owner', 'admin'];
export const isAdmin = (user: AuthUser | undefined): boolean =>
  !!user && ADMIN_ROLES.includes(user.globalRole);

/** Gate a route on one of the given global roles. Use after `requireAuth`. */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.globalRole)) {
      res.status(403).json({ error: 'You do not have permission to do that.' });
      return;
    }
    next();
  };
}
