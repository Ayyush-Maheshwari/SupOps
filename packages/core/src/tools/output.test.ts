import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamRedactor, redactSecrets, truncateOutput } from './output.ts';

const SECRET = 'hunter2-super-secret-value';
const creds = [{ value: SECRET, id: 'cred_1' }];

test('a secret split across two chunks never reaches the stream', () => {
  const r = new StreamRedactor(creds);
  // Split mid-secret, which is exactly what a naive per-chunk redactor misses.
  const a = r.push('DB_PASSWORD=hunter2-super');
  const b = r.push('-secret-value\nnext line\n');
  const c = r.flush();

  const all = a + b + c;
  assert.ok(!all.includes(SECRET), `leaked: ${JSON.stringify(all)}`);
  assert.match(all, /«redacted:cred_1»/);
  assert.match(all, /next line/);
});

test('a secret split across many small chunks is still caught', () => {
  const r = new StreamRedactor(creds);
  let out = '';
  for (const ch of `x=${SECRET}\n`) out += r.push(ch);
  out += r.flush();
  assert.ok(!out.includes(SECRET));
  assert.match(out, /«redacted:cred_1»/);
});

test('ordinary output passes through unchanged and in order', () => {
  const r = new StreamRedactor(creds);
  let out = '';
  for (const c of ['line one\n', 'line two\n', 'line three\n']) out += r.push(c);
  out += r.flush();
  assert.equal(out, 'line one\nline two\nline three\n');
});

test('with no secrets registered the stream is untouched', () => {
  const r = new StreamRedactor([]);
  assert.equal(r.push('anything at all'), 'anything at all');
  assert.equal(r.flush(), '');
});

test('truncation keeps head and tail and says how much was dropped', () => {
  const big = 'A'.repeat(50_000);
  const { text, truncated, originalBytes } = truncateOutput(big, 1000);
  assert.equal(truncated, true);
  assert.equal(originalBytes, 50_000);
  assert.match(text, /bytes omitted from the middle/);
  assert.ok(text.length < 2000);
});

test('redactSecrets ignores values too short to be distinctive', () => {
  assert.equal(redactSecrets('abc abc', [{ value: 'abc', id: 'x' }]), 'abc abc');
});

/**
 * The first implementation held back a window as long as the longest secret. With an
 * SSH private key registered (~3.3KB) that meant no command output under 3.3KB ever
 * streamed -- it all arrived at flush(), which looks identical to no streaming at all.
 */
test('a long secret does not block ordinary output from streaming', () => {
  const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'b3BlbnNz'.repeat(400)}\n-----END OPENSSH PRIVATE KEY-----`;
  const r = new StreamRedactor([{ value: key, id: 'cred_key' }]);

  assert.equal(r.push('line-1\n'), 'line-1\n', 'must emit immediately, not hold');
  assert.equal(r.push('line-2\n'), 'line-2\n');
  assert.equal(r.flush(), '');
});

test('output that starts to look like a secret is held until it is ruled out', () => {
  const secret = 'SUPER-SECRET-TOKEN';
  const r = new StreamRedactor([{ value: secret, id: 'c' }]);

  // A partial prefix at the tail is withheld...
  assert.equal(r.push('value=SUPER-SEC'), 'value=');
  // ...and released once the next chunk proves it was not the secret.
  assert.equal(r.push('ONDARY\n'), 'SUPER-SECONDARY\n');
  assert.equal(r.flush(), '');
});

test('and when it really is the secret, it is redacted not released', () => {
  const secret = 'SUPER-SECRET-TOKEN';
  const r = new StreamRedactor([{ value: secret, id: 'c' }]);
  const out = r.push('value=SUPER-SEC') + r.push('RET-TOKEN\n') + r.flush();
  assert.ok(!out.includes(secret));
  assert.match(out, /«redacted:c»/);
});
