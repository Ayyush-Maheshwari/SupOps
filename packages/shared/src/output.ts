/**
 * Output hygiene shared by everything that runs commands -- the engine, and later
 * the sandboxed toolbox, which must not depend on the engine or the database.
 */

/**
 * Cap tool output before it reaches the model.
 *
 * A single `journalctl` with no `--since` can return hundreds of megabytes. On a
 * frontier model that is merely expensive; on a local 8B with a 32K window it ends
 * the run. We keep the head and the tail -- the two places the useful information
 * actually lives -- and say plainly how much was dropped, so the agent knows to
 * narrow its query rather than assuming it saw everything.
 */
export function truncateOutput(text: string, maxBytes: number): {
  text: string;
  truncated: boolean;
  originalBytes: number;
} {
  // TextEncoder/TextDecoder rather than Buffer: this module is also bundled for the browser.
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const buf = enc.encode(text);
  const bytes = buf.length;
  if (bytes <= maxBytes) return { text, truncated: false, originalBytes: bytes };

  const half = Math.floor(maxBytes / 2);
  const head = dec.decode(buf.subarray(0, half));
  const tail = dec.decode(buf.subarray(buf.length - half));
  const dropped = bytes - enc.encode(head).length - enc.encode(tail).length;

  return {
    text:
      `${head}\n\n... [${dropped.toLocaleString()} bytes omitted from the middle of ` +
      `${bytes.toLocaleString()} total. Narrow the command (add --since, -n, or grep) ` +
      `if you need what is missing.] ...\n\n${tail}`,
    truncated: true,
    originalBytes: bytes,
  };
}

/**
 * Strip known secret values out of tool output before it is persisted or sent.
 *
 * This is not a nicety. Without it a single `cat /etc/app/config.yml` writes a
 * database password permanently into the run transcript and ships it to a
 * third-party API -- and unlike most leaks, the operator explicitly asked for it,
 * so nothing looks wrong.
 */
export function redactSecrets(text: string, secrets: Array<{ value: string; id: string }>): string {
  let out = text;
  for (const { value, id } of secrets) {
    // Very short secrets would match everywhere and destroy the output's meaning.
    if (!value || value.length < 6) continue;
    out = out.split(value).join(`«redacted:${id}»`);
  }
  return out;
}

/**
 * Redacts a stream of chunks.
 *
 * `redactSecrets` works on a complete string; a live stream can split a credential
 * across two chunks, so a naive per-chunk pass would leak it. This holds back a tail
 * as long as the longest secret and only releases text once it can no longer be part
 * of a straddling match.
 */
export class StreamRedactor {
  private secrets: Array<{ value: string; id: string }>;
  private hold = '';

  constructor(secrets: Array<{ value: string; id: string }>) {
    this.secrets = secrets.filter((s) => s.value && s.value.length >= 6);
  }

  /**
   * Feed a chunk; returns the portion safe to emit now.
   *
   * Only holds back a tail that could still *grow into* a secret -- i.e. a suffix of
   * the buffer that is a prefix of some secret. Holding back a fixed window the size
   * of the longest secret sounds safer but destroys streaming outright: an SSH
   * private key is ~3.3KB, so a fixed window never releases anything a command
   * actually prints. Ordinary output matches no prefix and flows straight through.
   */
  push(chunk: string): string {
    if (this.secrets.length === 0) return chunk;

    const buf = this.hold + chunk;
    const redacted = redactSecrets(buf, this.secrets);

    let keep = 0;
    for (const { value } of this.secrets) {
      const window = Math.min(value.length - 1, redacted.length);
      if (window <= 0) continue;

      // Scan from the earliest candidate so the first hit is the longest tail.
      let idx = redacted.indexOf(value[0]!, redacted.length - window);
      while (idx !== -1) {
        const tail = redacted.length - idx;
        if (tail < value.length && value.startsWith(redacted.slice(idx))) {
          if (tail > keep) keep = tail;
          break;
        }
        idx = redacted.indexOf(value[0]!, idx + 1);
      }
    }

    this.hold = keep > 0 ? redacted.slice(redacted.length - keep) : '';
    return keep > 0 ? redacted.slice(0, redacted.length - keep) : redacted;
  }

  /** Release whatever is still held. Call once the command has closed. */
  flush(): string {
    const rest = redactSecrets(this.hold, this.secrets);
    this.hold = '';
    return rest;
  }
}

/**
 * Well-known credential formats, matched by shape. Exact-value redaction only knows
 * the secrets SupOps itself stores; these catch the ones a command happens to print
 * (a token in a config file, a key the operator approved reading). Each pattern is
 * specific enough to be near-certain -- a false positive hides useful output.
 */
export const TOKEN_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'google-oauth', re: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

export function redactTokenPatterns(text: string): string {
  let out = text;
  for (const { id, re } of TOKEN_PATTERNS) out = out.replace(re, `«redacted:${id}»`);
  return out;
}
