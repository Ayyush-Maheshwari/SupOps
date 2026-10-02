import type { ToolOutput } from '@supops/db';

// The helpers live in @supops/shared so the sandboxed toolbox can use them without
// depending on the engine; re-exported here for existing imports.
export { redactSecrets, redactTokenPatterns, StreamRedactor, TOKEN_PATTERNS, truncateOutput } from '@supops/shared';

export const okOutput = (text: string, extra: Partial<ToolOutput> = {}): ToolOutput => ({
  ok: true,
  text,
  ...extra,
});

export const errOutput = (text: string, extra: Partial<ToolOutput> = {}): ToolOutput => ({
  ok: false,
  text,
  ...extra,
});
