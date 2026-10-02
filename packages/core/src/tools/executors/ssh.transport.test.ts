import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTransport } from './ssh.ts';

const CMD = "sudo -S -p '[[SUPOPS-SUDO:%p]]' kubectl get nodes";

test('no via hop returns the command unchanged', () => {
  assert.equal(buildTransport(undefined, CMD), CMD);
});

test('via hop wraps the command in ssh -tt <alias>, quoted', () => {
  assert.equal(
    buildTransport({ alias: 'logstore2' }, CMD),
    "ssh -tt logstore2 'sudo -S -p '\\''[[SUPOPS-SUDO:%p]]'\\'' kubectl get nodes'",
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
    wrapShell({ loginShell: true, prelude: 'prodlogin' }, 'oc get pods'),
    "bash -ic 'prodlogin; oc get pods'",
  );
  assert.equal(wrapShell({ loginShell: true }, 'kubectl get nodes'), "bash -ic 'kubectl get nodes'");
  assert.equal(wrapShell({}, 'df -h'), 'df -h');
});

test('via hop from an elevated account: sudo su - root wraps the whole hop', () => {
  assert.equal(
    buildTransport({ alias: 'uat-app1', become: { method: 'sudo-su' } }, 'df -h'),
    "sudo -S -p '[[SUPOPS-SUDO:%p]]' su - root -c 'ssh -tt uat-app1 '\\''df -h'\\'''",
  );
});

test('via hop with plain sudo runs ssh itself under sudo (reads root ~/.ssh/config)', () => {
  assert.equal(
    buildTransport({ alias: 'db1', become: { method: 'sudo' } }, 'uptime'),
    "sudo -S -p '[[SUPOPS-SUDO:%p]]' ssh -tt db1 uptime",
  );
});

test('via hop via su to a named account', () => {
  assert.equal(
    buildTransport({ alias: 'db1', become: { method: 'su', user: 'ops' } }, 'uptime'),
    "su - ops -c 'ssh -tt db1 uptime'",
  );
});
