import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrustRule, canonicalCommand, matchesRule, trustEnvOf, trustText } from './trust.ts';
import type { TrustRule } from './trust.ts';

const folderRule = (over: Partial<TrustRule> = {}): TrustRule => {
  const r = buildTrustRule({ toolKey: 'ssh_exec', command: 'rm -f /var/log/app/app.log.3.gz', matchKind: 'folder', folder: '/var/log/app', glob: '*.gz', envs: ['dev', 'staging'], tier: 'medium' });
  assert.ok(r.ok, !r.ok ? r.error : '');
  return { ...r.rule, ...over };
};

test('exact: spacing and a leading sudo do not matter; quoting does', () => {
  const r = buildTrustRule({ toolKey: 'ssh_exec', command: 'journalctl --vacuum-time=7d', matchKind: 'exact', envs: ['staging'], tier: 'medium' });
  assert.ok(r.ok);
  const rule = r.rule;
  assert.equal(matchesRule(rule, 'ssh_exec', '  journalctl   --vacuum-time=7d ', 'staging'), true);
  assert.equal(matchesRule(rule, 'ssh_exec', 'sudo -u root journalctl --vacuum-time=7d', 'staging'), true);
  assert.equal(matchesRule(rule, 'ssh_exec', 'journalctl --vacuum-time=1d', 'staging'), false);
  assert.equal(matchesRule(rule, 'ssh_exec', 'journalctl --vacuum-time=7d; rm -rf /', 'staging'), false);
  assert.equal(canonicalCommand("rm '/a/*.gz'") === canonicalCommand('rm /a/*.gz'), false, 'a quoted literal is not the glob');
});

test('exact: only in the environments the rule names; sensitivity 3 counts as production', () => {
  const r = buildTrustRule({ toolKey: 'ssh_exec', command: 'systemctl restart api', matchKind: 'exact', envs: ['staging'], tier: 'medium' });
  assert.ok(r.ok);
  assert.equal(matchesRule(r.rule, 'ssh_exec', 'systemctl restart api', 'prod'), false);
  assert.equal(trustEnvOf({ env: 'staging', sensitivity: 3 }), 'prod');
  assert.equal(trustEnvOf({ env: 'dev' }), 'dev');
});

test('folder: files under the folder that match the pattern; nothing else', () => {
  const rule = folderRule();
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f /var/log/app/app.log.7.gz', 'staging'), true);
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f /var/log/app/old/a.gz /var/log/app/b.gz', 'staging'), true, 'several files, all inside');
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f /var/log/app/../../../etc/passwd.gz', 'staging'), false, 'no traversal');
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f /var/log/app/app.log', 'staging'), false, 'name must match the pattern');
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f /var/log/app/*.gz', 'staging'), false, 'no wildcard operands');
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f app.log.3.gz', 'staging'), false, 'no relative paths');
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -rf /var/log/app/a.gz', 'staging'), false, 'same flags only');
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f /var/log/app/a.gz /etc/x.gz', 'staging'), false, 'every file must be inside');
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f /var/log/app/a.gz && reboot', 'staging'), false, 'one simple command');
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f /var/log/app/a.gz > /tmp/x', 'staging'), false, 'no redirects');
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f /var/log/app', 'staging'), false, 'not the folder itself');
  assert.equal(matchesRule(rule, 'ssh_exec', 'rm -f /var/log/app/a.gz', 'prod'), false, 'production is opt-in');
});

test('rules that are refused', () => {
  const base = { toolKey: 'ssh_exec', matchKind: 'exact' as const, envs: ['dev' as const], tier: 'medium' };
  assert.equal(buildTrustRule({ ...base, command: 'rm -rf /', tier: 'forbidden' }).ok, false, 'forbidden never');
  assert.equal(buildTrustRule({ ...base, command: 'rm $(cat list)' }).ok, false, 'unreadable');
  assert.equal(buildTrustRule({ ...base, command: 'ls', envs: [] }).ok, false, 'needs an environment');
  const folder = { ...base, matchKind: 'folder' as const, command: 'rm /etc/app/x.conf', glob: '*.conf' };
  assert.equal(buildTrustRule({ ...folder, folder: '/etc/app' }).ok, false, 'never under /etc');
  assert.equal(buildTrustRule({ ...folder, command: 'rm /var/x.gz', folder: '/var', glob: '*.gz' }).ok, false, 'too broad');
  assert.equal(buildTrustRule({ ...folder, command: 'rm /var/log/app/x.gz', folder: '/var/log/other', glob: '*.gz' }).ok, false, 'must cover its own command');
});

test('kubectl: exact only, with or without the leading kubectl', () => {
  const text = trustText('k8s_kubectl', { args: 'rollout restart deploy/api -n web' })!;
  const r = buildTrustRule({ toolKey: 'k8s_kubectl', command: text, matchKind: 'exact', envs: ['staging'], tier: 'medium' });
  assert.ok(r.ok);
  assert.equal(matchesRule(r.rule, 'k8s_kubectl', trustText('k8s_kubectl', { args: 'kubectl rollout restart deploy/api -n web' })!, 'staging'), true);
  assert.equal(matchesRule(r.rule, 'ssh_exec', text, 'staging'), false, 'a rule is for its own tool');
  assert.equal(buildTrustRule({ toolKey: 'k8s_kubectl', command: text, matchKind: 'folder', folder: '/var/log/x', glob: '*', envs: ['dev'], tier: 'medium' }).ok, false);
});
