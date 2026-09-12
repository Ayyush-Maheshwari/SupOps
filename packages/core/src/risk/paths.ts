import type { ResolvedTarget } from '../tools/types.ts';

export const DEFAULT_PROTECTED_PATHS = [
  '/etc',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/var/lib',
  '/root',
  '/home/*/.ssh',
];

/** Devices are not merely protected -- writing to one is unrecoverable. */
const DEVICE_PATHS = [/^\/dev\/(sd|nvme|vd|hd|mmcblk|xvd)/, /^\/dev\/disk/];

export const isDevicePath = (p: string): boolean => DEVICE_PATHS.some((r) => r.test(p));

function normalise(p: string): string {
  // Resolve `..` conservatively: we are deciding whether to trust this path, so a
  // traversal that escapes its prefix must be judged on where it lands.
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return (p.startsWith('/') ? '/' : '') + out.join('/');
}

function matchesGlobPrefix(path: string, pattern: string): boolean {
  const pathParts = normalise(path).split('/').filter(Boolean);
  const patParts = normalise(pattern).split('/').filter(Boolean);
  if (pathParts.length < patParts.length) {
    // `/etc` itself counts as inside `/etc`.
    return patParts.slice(0, pathParts.length).every((p, i) => p === '*' || p === pathParts[i])
      && pathParts.length === patParts.length;
  }
  return patParts.every((p, i) => p === '*' || p === pathParts[i]);
}

export function isProtectedPath(path: string, target: ResolvedTarget): boolean {
  if (!path.startsWith('/')) return false; // relative paths are judged by the command, not here
  const patterns = target.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  return patterns.some((pat) => matchesGlobPrefix(path, pat));
}

export function isWritablePath(path: string, target: ResolvedTarget): boolean {
  const patterns = target.writablePaths ?? ['/tmp', '/var/tmp'];
  return patterns.some((pat) => matchesGlobPrefix(path, pat));
}

/** A path that is safe to delete a specific file from at `medium` rather than `high`. */
export function isScratchPath(path: string, target: ResolvedTarget): boolean {
  if (isWritablePath(path, target)) return true;
  return ['/tmp', '/var/tmp', '/var/log', '/var/cache'].some((p) =>
    matchesGlobPrefix(path, p),
  );
}

/** Globs and wildcards make blast radius unknowable from the string alone. */
export const hasGlob = (s: string): boolean => /[*?\[\]]/.test(s);
