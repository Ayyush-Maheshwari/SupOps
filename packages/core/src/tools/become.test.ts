import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedTarget } from './types.ts';
import { wrapCommand, wrapScript } from './become.ts';

type Become = { method: 'none' | 'sudo' | 'su' | 'sudo-su'; user?: string; pty?: boolean; template?: string };

function target(become?: Become): ResolvedTarget {
  return {
    id: 't', slug: 't', kind: 'ssh', env: 'prod', sensitivity: 1, description: null,
    config: { kind: 'ssh', host: 'h', port: 22, user: 'ops', sudo: false, ...(become ? { become } : {}) },
    credentialId: null,
    protectedPaths: null, writablePaths: null, unitAllowlist: null,
  } as ResolvedTarget;
}

test('none / no profile leaves the command untouched', () => {
  assert.equal(wrapCommand(target(), 'df -h'), 'df -h');
  assert.equal(wrapCommand(target({ method: 'none' }), 'df -h'), 'df -h');
});

test('sudo prepends sudo -S with the machine-readable prompt', () => {
  assert.equal(
    wrapCommand(target({ method: 'sudo' }), 'systemctl restart nginx'),
    "sudo -S -p '[[SUPOPS-SUDO:%p]]' systemctl restart nginx",
  );
});

test('sudo with a become-user adds -u', () => {
  assert.equal(
    wrapCommand(target({ method: 'sudo', user: 'appuser' }), 'whoami'),
    "sudo -S -p '[[SUPOPS-SUDO:%p]]' -u appuser whoami",
  );
});

test('su - user wraps in a quoted -c', () => {
  assert.equal(wrapCommand(target({ method: 'su', user: 'bejoy' }), 'df -h'), "su - bejoy -c 'df -h'");
});

test('sudo-su is the jump-host pattern', () => {
  assert.equal(
    wrapCommand(target({ method: 'sudo-su', user: 'bejoy' }), 'kubectl get pods'),
    "sudo -S -p '[[SUPOPS-SUDO:%p]]' su - bejoy -c 'kubectl get pods'",
  );
});

test('a template overrides the method and quotes the command', () => {
  assert.equal(
    wrapCommand(target({ method: 'none', template: 'kubectl exec pod -- {{CMD}}' }), 'ls /'),
    "kubectl exec pod -- 'ls /'",
  );
});

test('wrapScript routes non-su methods through sh -c and preserves newlines', () => {
  const script = "cat > /etc/app.conf <<'EOF'\nkey: value\nEOF";
  const out = wrapScript(target({ method: 'sudo' }), script);
  assert.ok(out.startsWith("sudo -S -p '[[SUPOPS-SUDO:%p]]' sh -c '"));
  assert.ok(out.includes('key: value'));
  // su-based methods use su -c directly
  assert.ok(wrapScript(target({ method: 'sudo-su', user: 'bejoy' }), script).startsWith("sudo -S -p '[[SUPOPS-SUDO:%p]]' su - bejoy -c '"));
});

import { pickBecomePassword } from './become.ts';

test('pickBecomePassword prefers an exact user, then the wildcard, else null', () => {
  const secrets = [
    { user: 'vishnu', value: 'pw-v' },
    { user: 'vishnu-haptik', value: 'pw-vh' },
    { user: '', value: 'pw-default' },
  ];
  assert.equal(pickBecomePassword(secrets, 'vishnu'), 'pw-v');
  assert.equal(pickBecomePassword(secrets, 'vishnu-haptik'), 'pw-vh');
  assert.equal(pickBecomePassword(secrets, 'someone-else'), 'pw-default');
  assert.equal(pickBecomePassword([{ user: 'vishnu', value: 'pw-v' }], 'other'), null);
  assert.equal(pickBecomePassword(undefined, 'x'), null);
});

test('template composes with sudo (jump host + far-side sudo)', () => {
  const t = target({ method: 'sudo', template: 'ssh -tt loglake2 {{CMD}}' });
  const out = wrapCommand(t, 'kubectl get nodes');
  // sudo is applied to the inner command, then the whole thing is handed to ssh.
  assert.equal(out, "ssh -tt loglake2 'sudo -S -p '\\''[[SUPOPS-SUDO:%p]]'\\'' kubectl get nodes'");
});

test('template with method none still just wraps the bare command', () => {
  const t = target({ method: 'none', template: 'kubectl exec pod -- {{CMD}}' });
  assert.equal(wrapCommand(t, 'ls /'), "kubectl exec pod -- 'ls /'");
});
