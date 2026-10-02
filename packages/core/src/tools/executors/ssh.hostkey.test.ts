import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostKeyFingerprint, verifyHostKey } from './ssh.ts';

test('fingerprints match OpenSSH (ssh-keygen -lf)', () => {
  // Public key blob of a throwaway ed25519 key, and what ssh-keygen -lf printed for it.
  const blob = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIHyuLhclq/t7jYEhOMl9AZ3mcGw7y8wYwfUzOjijL7Z7', 'base64');
  assert.equal(hostKeyFingerprint(blob), 'SHA256:JhIg8O34/t0cx6zFlcBjnihSx1vpOf8eXXNcH6LOM1w');
});

test('trust on first use: pin a new key, accept the same key, refuse a changed one', () => {
  assert.equal(verifyHostKey(undefined, 'SHA256:aaa'), 'accept-new');
  assert.equal(verifyHostKey('SHA256:aaa', 'SHA256:aaa'), 'accept');
  assert.equal(verifyHostKey('SHA256:aaa', 'SHA256:bbb'), 'reject');
});
