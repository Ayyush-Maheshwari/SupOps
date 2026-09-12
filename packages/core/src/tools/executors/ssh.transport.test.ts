import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTransport } from './ssh.ts';

const CMD = "sudo -S -p '[[SUPOPS-SUDO:%p]]' kubectl get nodes";

test('no via hop returns the command unchanged', () => {
  assert.equal(buildTransport(undefined, CMD), CMD);
});

test('via hop wraps the command in ssh -tt <alias>, quoted', () => {
  assert.equal(
    buildTransport({ alias: 'loglake2' }, CMD),
    "ssh -tt loglake2 'sudo -S -p '\\''[[SUPOPS-SUDO:%p]]'\\'' kubectl get nodes'",
  );
});

test('pty:false drops -tt; sshFlags are included', () => {
  assert.equal(
    buildTransport({ alias: 'vm1', pty: false, sshFlags: '-o StrictHostKeyChecking=accept-new' }, 'whoami'),
    'ssh -o StrictHostKeyChecking=accept-new vm1 whoami',
  );
});

import { wrapShell } from './ssh.ts';

test('login shell + prelude wraps the command (alias loads, prelude runs first)', () => {
  assert.equal(
    wrapShell({ loginShell: true, prelude: 'prodrosa' }, 'oc get pods'),
    "bash -ic 'prodrosa; oc get pods'",
  );
  assert.equal(wrapShell({ loginShell: true }, 'kubectl get nodes'), "bash -ic 'kubectl get nodes'");
  assert.equal(wrapShell({}, 'df -h'), 'df -h');
});
