import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signatureOf } from './signature.ts';

const sig = (command: string) => signatureOf('ssh_exec', { command });

test('flag order, clustered flags and sudo do not change the signature', () => {
  assert.equal(sig('journalctl -u app -n 50'), sig('journalctl -n 50 -u app'));
  assert.equal(sig('rm -rf /tmp/x'), sig('rm -fr /tmp/x'));
  assert.equal(sig('sudo systemctl restart nginx'), sig('systemctl restart nginx'));
});

test('numbers are generalised, but different targets of a command stay different', () => {
  assert.equal(sig('kill 1234'), sig('kill 5678'));
  assert.notEqual(sig('systemctl restart nginx'), sig('systemctl restart postgres'));
  assert.notEqual(sig('rm /tmp/a'), sig('rm /etc/a'));
});

test('kubectl args and file tools are signed; unparseable lines are not', () => {
  assert.equal(signatureOf('k8s_kubectl', { args: 'delete pod api-1 -n prod' }), signatureOf('k8s_kubectl', { args: 'kubectl delete pod api-1 -n prod' }));
  assert.notEqual(signatureOf('k8s_kubectl', { args: 'delete pod api-1 -n prod' }), signatureOf('k8s_kubectl', { args: 'delete pod api-1 -n dev' }));
  assert.match(String(signatureOf('ssh_write_file', { path: '/etc/x.conf' })), /^v1\|ssh_write_file\|\/etc\/x.conf$/);
  assert.equal(sig('for i in 1 2; do echo $i; done'), null);
  assert.equal(signatureOf('record_finding', { finding: 'x' }), null);
});

test('signatures are deterministic and versioned', () => {
  assert.equal(sig('df -h'), sig('df -h'));
  assert.match(String(sig('df -h')), /^v1\|ssh_exec\|df -h$/);
});
