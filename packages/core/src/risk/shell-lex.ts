/**
 * A deliberately small, deliberately paranoid shell reader.
 *
 * We are not writing a shell. We are answering one question -- "which programs does
 * this line run, with which arguments?" -- and we would rather refuse to answer than
 * answer wrongly. Every construct that could hide a command name from us (command
 * substitution, eval, arithmetic expansion, a quoted-up `r''m`) makes us fail closed
 * by returning null, which the classifier turns into `high`.
 *
 * This costs some legitimate one-liners. That is the intended trade: the agent
 * learns to split them, and we never mistake `$(echo cm0K|base64 -d) -rf /` for a
 * command we recognise.
 */

export interface Redirect {
  op: '>' | '>>' | '<' | '2>' | '2>>' | '&>';
  path: string;
}

export interface SimpleCommand {
  /** argv[0] with any path prefix kept (`/bin/rm` stays `/bin/rm`). */
  name: string;
  args: string[];
  redirects: Redirect[];
  raw: string;
  /** True when this command's output is piped into another. */
  pipedInto: boolean;
}

/** Constructs whose expansion we cannot see. Their presence alone is disqualifying. */
const OBFUSCATION = [
  { pattern: '$(', reason: 'command substitution' },
  { pattern: '`', reason: 'backtick command substitution' },
  { pattern: '<(', reason: 'process substitution' },
  { pattern: '>(', reason: 'process substitution' },
  { pattern: '${', reason: 'parameter expansion' },
  { pattern: '$((', reason: 'arithmetic expansion' },
] as const;

export interface LexFailure {
  ok: false;
  reason: string;
}
export interface LexSuccess {
  ok: true;
  commands: SimpleCommand[];
}
export type LexResult = LexSuccess | LexFailure;

export function lexShell(input: string): LexResult {
  const command = input.trim();
  if (!command) return { ok: false, reason: 'empty command' };

  for (const { pattern, reason } of OBFUSCATION) {
    if (command.includes(pattern)) {
      return { ok: false, reason: `contains ${reason} (${pattern})` };
    }
  }
  // A bare `$VAR` is fine to *see*, but we cannot know what it holds, so anything
  // that could become a command name through it is refused.
  if (/(^|[\s;&|])\$[A-Za-z_]/.test(command)) {
    return { ok: false, reason: 'command name may come from a variable' };
  }

  const segments = splitOnControlOperators(command);
  if (!segments) return { ok: false, reason: 'unbalanced quotes' };

  const commands: SimpleCommand[] = [];
  for (const seg of segments) {
    const parsed = parseSimpleCommand(seg.text, seg.pipedInto);
    if (!parsed.ok) return parsed;
    if (parsed.command) commands.push(parsed.command);
  }

  if (commands.length === 0) return { ok: false, reason: 'no command found' };
  return { ok: true, commands };
}

interface Segment {
  text: string;
  pipedInto: boolean;
}

/** Split on ; && || | & while respecting quotes. Returns null on unbalanced quotes. */
function splitOnControlOperators(input: string): Segment[] | null {
  const segments: Segment[] = [];
  let buf = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = (pipedInto: boolean) => {
    if (buf.trim()) segments.push({ text: buf.trim(), pipedInto });
    buf = '';
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      buf += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      buf += ch;
      quote = ch;
      continue;
    }

    const two = input.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push(false);
      i += 1;
      continue;
    }
    if (ch === '|') {
      push(true);
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '\n') {
      push(false);
      continue;
    }
    buf += ch;
  }

  if (quote || escaped) return null;
  push(false);
  return segments;
}

const REDIRECT_OPS: Redirect['op'][] = ['2>>', '2>', '&>', '>>', '>', '<'];

function parseSimpleCommand(
  text: string,
  pipedInto: boolean,
): { ok: true; command: SimpleCommand | null } | LexFailure {
  const tokens = tokenize(text);
  if (!tokens) return { ok: false, reason: 'unbalanced quotes in command' };
  if (tokens.length === 0) return { ok: true, command: null };

  const args: string[] = [];
  const redirects: Redirect[] = [];
  let name: string | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const op = REDIRECT_OPS.find((o) => tok.raw === o || tok.raw.startsWith(o));
    if (op && !tok.quoted) {
      const inline = tok.raw.slice(op.length);
      const path = inline || tokens[++i]?.value;
      if (!path) return { ok: false, reason: 'redirect without a destination' };
      redirects.push({ op, path });
      continue;
    }

    if (name === null) {
      // `r''m`, `"rm"`, `\rm` -- all resolve to `rm` but defeat naive matching.
      // We refuse rather than normalise, because normalising is where this class
      // of bypass historically wins.
      if (tok.quoted || tok.raw.includes('\\')) {
        return { ok: false, reason: `command name is quoted or escaped: ${tok.raw}` };
      }
      // Leading VAR=value assignments, then the real command.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.raw)) continue;
      name = tok.value;
      continue;
    }
    args.push(tok.value);
  }

  if (name === null) return { ok: true, command: null };
  return { ok: true, command: { name, args, redirects, raw: text, pipedInto } };
}

interface Token {
  /** Quotes stripped. */
  value: string;
  /** As written. */
  raw: string;
  quoted: boolean;
}

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let value = '';
  let raw = '';
  let quoted = false;
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    if (started) tokens.push({ value, raw, quoted });
    value = '';
    raw = '';
    quoted = false;
    started = false;
  };

  for (const ch of text) {
    if (escaped) {
      value += ch;
      raw += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      raw += ch;
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      raw += ch;
      if (ch === quote) {
        quote = null;
      } else {
        value += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      started = true;
      raw += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flush();
      continue;
    }
    value += ch;
    raw += ch;
    started = true;
  }

  if (quote || escaped) return null;
  flush();
  return tokens;
}
