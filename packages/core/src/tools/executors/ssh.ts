import { Client } from 'ssh2';
import type { ToolOutput } from '@supops/db';
import type { ExecContext } from '../types.ts';
import { StreamRedactor, truncateOutput } from '../output.ts';
import { isPrivateKey } from '../secrets.ts';
import {
  SUDO_PROMPT_RE,
  becomeUser,
  pickBecomePassword,
  shellQuote,
  targetElevates,
} from '../become.ts';

/** A bare `su`/login password prompt, which (unlike sudo's) names no account. */
const BARE_PW_PROMPT = /password:\s*$/i;
/** Strip the sudo `%p` sentinel wherever it lands in output. */
const SENTINEL_G = /\[\[SUPOPS-SUDO:[^\]]*\]\]/g;
/** Never answer more than this many prompts -- sudo retries a wrong password. */
const MAX_PROMPT_ANSWERS = 3;

interface ViaHop {
  alias: string;
  pty?: boolean;
  sshFlags?: string;
}

/**
 * Wrap a command in a second SSH hop taken ON the connected (jump) host, so the
 * jump's own ~/.ssh/config resolves the alias, real host and key. Transport only:
 * it is never classified -- the classified/approved command is the one that runs on
 * the inner host. `-tt` forces a PTY so a far-side sudo prompt has a terminal.
 */
export function buildTransport(via: ViaHop | undefined, command: string): string {
  if (!via) return command;
  const flags = [via.pty === false ? '' : '-tt', via.sshFlags ?? ''].filter(Boolean).join(' ');
  return `ssh ${flags ? `${flags} ` : ''}${shellQuote(via.alias)} ${shellQuote(command)}`;
}

/** Trim the login banner an interactive `ssh -tt` prints before the command runs. */
function stripBanner(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^[\s\S]*?Last login:[^\n]*\n/, '') // everything up to and incl. the login line
    .replace(/^\s*Authorized uses only\.[^\n]*\n/gm, '')
    // Job-control chatter an interactive `bash -i` prints without a full controlling tty.
    .replace(/^bash: (cannot set terminal process group|no job control in this shell).*\n/gim, '');
}

/**
 * Run the command in a login+interactive shell (so ~/.bashrc aliases/functions/PATH
 * load) and/or after a prelude, when the target asks for it. Transport only -- this
 * wrapper is applied at dispatch, never classified. A prelude alias like `prodrosa`
 * only resolves inside a login shell, so the two go together.
 */
export function wrapShell(cfg: { loginShell?: boolean; prelude?: string }, command: string): string {
  if (!cfg.loginShell && !cfg.prelude) return command;
  const inner = cfg.prelude ? `${cfg.prelude}; ${command}` : command;
  // `bash -ic` runs an INTERACTIVE shell, which always sources ~/.bashrc -- where
  // aliases and functions like `prodrosa` live. A login shell (`-l`) sources the
  // profile instead and reaches ~/.bashrc only if the profile happens to source it,
  // which is why aliases went missing there.
  return cfg.loginShell ? `bash -ic ${shellQuote(inner)}` : `bash -c ${shellQuote(inner)}`;
}

/**
 * Run one command over SSH.
 *
 * Deliberately not a persistent session: each call connects, runs, and
 * disconnects. That costs a handshake per command and buys something worth far
 * more -- no shell state carries between calls, so a `cd` or an exported variable
 * in one tool call cannot silently change the meaning of the next one, and the
 * command we classified is exactly the command that runs.
 */
export async function sshExec(
  command: string,
  ctx: ExecContext,
): Promise<ToolOutput> {
  const cfg = ctx.target.config;
  if (cfg.kind !== 'ssh') {
    throw new Error(`Target ${ctx.target.slug} is not an SSH target`);
  }

  const started = Date.now();
  const conn = new Client();

  return new Promise<ToolOutput>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    // Live chunks bypass the post-run redaction pass, so they get their own
    // stream-aware redactor that holds back enough text to catch a secret split
    // across a chunk boundary. Both the login secret and the elevation password
    // are masked, since either can echo into command output.
    const liveSecrets: Array<{ value: string; id: string }> = [];
    if (ctx.target.secret) liveSecrets.push({ value: ctx.target.secret, id: 'credential' });
    for (const [i, b] of (ctx.target.becomeSecrets ?? []).entries()) {
      liveSecrets.push({ value: b.value, id: `become-${i}` });
    }
    const live = ctx.onChunk ? new StreamRedactor(liveSecrets) : null;
    const emit = (text: string) => {
      if (!ctx.onChunk || !live) return;
      // Never surface the machine-readable sudo prompt to a viewer or the model.
      const safe = live.push(text.replace(SENTINEL_G, ''));
      if (safe) ctx.onChunk(safe);
    };

    const finish = (out: ToolOutput) => {
      if (settled) return;
      settled = true;
      conn.end();
      resolve({ ...out, durationMs: Date.now() - started });
    };

    const fail = (message: string) =>
      finish({ ok: false, text: message, exitCode: -1 });

    const timer = setTimeout(() => {
      fail(
        `Command timed out after ${ctx.timeoutMs}ms and was terminated. ` +
          `Partial output:\n${truncateOutput(stdout + stderr, ctx.maxOutputBytes).text}`,
      );
    }, ctx.timeoutMs);

    const onAbort = () => fail('Run was cancelled; the command was terminated.');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    };

    // Elevation needs a PTY: `su` refuses to read a password from a bare pipe, and
    // it lets us read sudo's prompt and answer with the right password at runtime.
    // A second hop needs one too, so the inner `ssh -tt` has a terminal to attach.
    const elevates = targetElevates(ctx.target);
    // Transport (never classified): run the command in a login shell / after a prelude
    // if asked, then reach the real machine by running `ssh <alias>` on the jump.
    const toRun = buildTransport(cfg.via, wrapShell(cfg, command));

    conn
      .on('ready', () => {
        const execOpts = elevates || cfg.via || cfg.loginShell ? { pty: true } : {};
        conn.exec(toRun, execOpts, (err, stream) => {
          if (err) {
            cleanup();
            return fail(`Failed to start command: ${err.message}`);
          }

          // Answer a sudo/su password prompt with the password for the account the
          // prompt actually names. sudo is told to print `[[SUPOPS-SUDO:<user>]]`
          // (via `-p '%p'`); a bare `su` prompt names no account, so we fall back to
          // the target's configured become-user. Capped, because sudo re-prompts on
          // a wrong password and we must not loop.
          let promptScan = '';
          let answers = 0;
          const maybeAnswer = () => {
            if (!elevates || answers >= MAX_PROMPT_ANSWERS) return;
            const m = promptScan.match(SUDO_PROMPT_RE);
            let user: string | null = null;
            if (m) user = m[1] ?? '';
            else if (BARE_PW_PROMPT.test(promptScan)) user = becomeUser(ctx.target);
            if (user === null) return;
            const pw = pickBecomePassword(ctx.target.becomeSecrets, user);
            promptScan = ''; // consume up to the prompt we just handled
            if (pw === null) return; // no password for this account; let sudo fail
            answers += 1;
            stream.write(`${pw}\n`);
          };

          stream
            .on('close', (code: number | null) => {
              cleanup();
              if (live && ctx.onChunk) {
                const rest = live.flush();
                if (rest) ctx.onChunk(rest);
              }
              // Strip the sudo sentinel, and (when we hopped) the inner ssh login banner.
              const clean = (s: string) => {
                const noSentinel = s.replace(SENTINEL_G, '');
                return cfg.via || cfg.loginShell ? stripBanner(noSentinel) : noSentinel;
              };
              const combined = clean(stdout) + (stderr ? `\n[stderr]\n${clean(stderr)}` : '');
              const { text, truncated, originalBytes } = truncateOutput(
                combined.trim() || '(no output)',
                ctx.maxOutputBytes,
              );
              const exitCode = code ?? -1;
              finish({
                ok: exitCode === 0,
                text: `[exit ${exitCode}]\n${text}`,
                exitCode,
                truncated,
                originalBytes,
              });
            })
            .on('data', (d: Buffer) => {
              const text = d.toString('utf8');
              stdout += text;
              if (elevates) { promptScan += text; maybeAnswer(); }
              emit(text);
            })
            .stderr.on('data', (d: Buffer) => {
              const text = d.toString('utf8');
              stderr += text;
              if (elevates) { promptScan += text; maybeAnswer(); }
              emit(text);
            });
        });
      })
      .on('error', (err) => {
        cleanup();
        fail(`SSH connection to ${cfg.host}:${cfg.port} failed: ${err.message}`);
      })
      .connect({
        host: cfg.host,
        port: cfg.port,
        username: cfg.user,
        readyTimeout: Math.min(ctx.timeoutMs, 20_000),
        ...credentialFor(ctx),
      });
  });
}

function credentialFor(ctx: ExecContext): { password?: string; privateKey?: string } {
  const secret = ctx.target.secret;
  if (!secret) return {};
  // Uses the same classifier as credential validation, so what we store and what we
  // offer to the server can never disagree.
  return isPrivateKey(secret) ? { privateKey: secret } : { password: secret };
}

/** Connectivity check for the Targets screen. Read-only by construction. */
export async function sshPing(ctx: ExecContext): Promise<ToolOutput> {
  return sshExec('echo supops-ok', ctx);
}
