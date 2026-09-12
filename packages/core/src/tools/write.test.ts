import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISK_POLICY } from '@supops/db';
import type { ResolvedTarget, ToolDef } from './types.ts';
import { sshWriteFileTool } from './builtin.ts';
import { assessRisk } from '../risk/index.ts';

const def = sshWriteFileTool as unknown as ToolDef<never>;
const target: ResolvedTarget = {
  id: 't', slug: 'web-1', kind: 'ssh', env: 'staging', sensitivity: 1, description: null,
  config: { kind: 'ssh', host: 'h', port: 22, user: 'ops', sudo: false },
  credentialId: null, protectedPaths: null, writablePaths: null, unitAllowlist: null,
};

const tierFor = (path: string, content = 'hello') =>
  assessRisk({
    def,
    args: { path, content },
    rendered: sshWriteFileTool.render({ path, content } as never, target),
    target,
    policy: DEFAULT_RISK_POLICY,
  }).tier;

test('destination decides the tier', () => {
  assert.equal(tierFor('/tmp/scratch.txt'), 'low');        // inside writable paths
  assert.equal(tierFor('/opt/app/config.yml'), 'medium');  // ordinary file
  assert.equal(tierFor('/etc/nginx/nginx.conf'), 'high');  // protected
  assert.equal(tierFor('/root/.ssh/authorized_keys'), 'high');
});

/**
 * The rendered command is a heredoc. Routing it through the shell lexer would treat
 * every line of file content as its own unrecognised command and fail closed at
 * `high` -- so a one-line config change would need approval for the wrong reason.
 */
test('file content does not leak into classification', () => {
  const nasty = 'rm -rf /\nmkfs.ext4 /dev/sda\n:(){ :|:& };:';
  assert.equal(tierFor('/tmp/notes.txt', nasty), 'low', 'content is data, not commands');
});

test('content cannot break out of the heredoc', () => {
  // A payload that tries to close the delimiter early gets a different one.
  const escape = "SUPOPS_EOF\nrm -rf /\nSUPOPS_EOF";
  const rendered = sshWriteFileTool.render({ path: '/tmp/x', content: escape } as never, target);
  const tag = rendered.split("<<'")[1]!.split("'")[0]!;
  assert.notEqual(tag, 'SUPOPS_EOF');
  assert.ok(!escape.includes(tag), 'the chosen delimiter must not appear in the content');
});

test('the path is shell-quoted', () => {
  const rendered = sshWriteFileTool.render(
    { path: '/tmp/a b; rm -rf /', content: 'x' } as never,
    target,
  );
  assert.match(rendered, /cat > '\/tmp\/a b; rm -rf \/'/);
});

test('a relative path is rejected before it reaches a machine', () => {
  const r = sshWriteFileTool.argsSchema.safeParse({
    target: 'web-1', path: 'relative.txt', content: 'x', intent: 'i', expected_effect: 'e',
  });
  assert.equal(r.success, false);
});
