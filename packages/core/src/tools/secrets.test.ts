import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseSecret, isPrivateKey } from './secrets.ts';

const BODY = [
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAACFwAAAAdzc2gtcn',
  'NhAAAAAwEAAQAAAgEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
].join('\n');

test('a complete OpenSSH key is accepted as a key', () => {
  const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.deepEqual(diagnoseSecret(key), { kind: 'private_key', problem: null });
  assert.equal(isPrivateKey(key), true);
});

/**
 * The exact failure that cost a real debugging session: a partial copy drops the
 * armor, the value is classified as a password, and SSH reports
 * "All configured authentication methods failed" -- which points at the server.
 */
test('key material with the armor stripped is caught, not mistaken for a password', () => {
  const d = diagnoseSecret(BODY);
  assert.equal(d.kind, 'private_key', 'must not be treated as a password');
  assert.match(d.problem ?? '', /BEGIN .* PRIVATE KEY/);
});

test('a truncated key missing only its END line is caught', () => {
  const d = diagnoseSecret(`-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY}\n`);
  assert.equal(d.kind, 'private_key');
  assert.match(d.problem ?? '', /END/);
});

test('a passphrase-protected key is rejected, since nothing can type the passphrase', () => {
  const d = diagnoseSecret(
    '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,AB\nMIIabc\n-----END RSA PRIVATE KEY-----',
  );
  assert.match(d.problem ?? '', /passphrase/);
});

test('an ordinary password passes through untouched', () => {
  assert.deepEqual(diagnoseSecret('hunter2'), { kind: 'password', problem: null });
  assert.equal(isPrivateKey('hunter2'), false);
});

test('a multi-line password is flagged as suspicious', () => {
  assert.match(diagnoseSecret('two\nlines').problem ?? '', /single line/);
});
