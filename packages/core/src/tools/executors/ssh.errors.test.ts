import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sshErrorHint } from './ssh.ts';

test('DNS failures point at name resolution', () => {
  assert.match(sshErrorHint({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND db01' }), /resolve/);
});

test('timeouts and unreachable hosts point at routing', () => {
  assert.match(sshErrorHint({ message: 'Timed out while waiting for handshake' }), /no route/);
  assert.match(sshErrorHint({ code: 'EHOSTUNREACH' }), /no route/);
});

test('refused connections point at the SSH port', () => {
  assert.match(sshErrorHint({ code: 'ECONNREFUSED' }), /SSH port/);
});

test('auth failures point at the credential', () => {
  assert.match(sshErrorHint({ message: 'All configured authentication methods failed' }), /rejected/);
});

test('unknown errors add no hint', () => {
  assert.equal(sshErrorHint({ message: 'something else' }), '');
});
