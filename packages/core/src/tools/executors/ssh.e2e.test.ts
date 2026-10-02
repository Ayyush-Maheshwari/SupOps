import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import type { ResolvedTarget } from '../types.ts';
import { sshExec } from './ssh.ts';

const { Server, utils } = ssh2;

/**
 * A real SSH server in-process. Every exec behaves like `ssh <alias>` on a jump that
 * has never seen the far host: it asks OpenSSH's first-contact question and only
 * runs once it reads "yes".
 */
function startServer(): Promise<{ port: number; close: () => void }> {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    // The refused (changed-key) client drops mid-handshake; that's the point, not an error.
    client.on('error', () => {});
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (ok) => ok?.());
        session.on('exec', (ok) => {
          const stream = ok();
          stream.write(
            "The authenticity of host 'vm1 (10.0.0.9)' can't be established.\r\n" +
              'ED25519 key fingerprint is SHA256:FarHostKeyFingerprint0000000000000000000000.\r\n' +
              'This key is not known by any other names.\r\n' +
              'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
          );
          let got = '';
          stream.on('data', (d: Buffer) => {
            got += d.toString();
            if (got.includes('yes\n')) {
              stream.write("\r\nWarning: Permanently added 'vm1' (ED25519) to the list of known hosts.\r\n");
              stream.write('hello-from-vm1\r\n');
              stream.exit(0);
              stream.end();
            }
          });
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() });
    });
  });
}

const target = (port: number, hostKeyFingerprint?: string): ResolvedTarget => ({
  id: 'vm1', slug: 'vm1', kind: 'ssh', env: 'dev', sensitivity: 0, description: null,
  config: {
    kind: 'ssh', host: '127.0.0.1', port, user: 'ops', sudo: false,
    via: { alias: 'vm1' },
    ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}),
  },
  credentialId: null, protectedPaths: null, writablePaths: null, unitAllowlist: null,
  secret: 'not-a-real-password',
});

const run = (t: ResolvedTarget, onNewHostKey?: (fp: string) => void) =>
  sshExec('uptime', {
    runId: 'r', toolCallId: 'c', target: t, timeoutMs: 10_000, maxOutputBytes: 8192,
    signal: AbortSignal.timeout(15_000), ...(onNewHostKey ? { onNewHostKey } : {}),
  });

test('first contact: pins the host key, answers the hop prompt, and later refuses a changed key', async () => {
  const srv = await startServer();
  try {
    const pinned: string[] = [];
    const first = await run(target(srv.port), (fp) => pinned.push(fp));
    assert.equal(first.ok, true, first.text);
    assert.match(first.text, /hello-from-vm1/);
    assert.match(first.text, /first connection from the jump to vm1: trusted SHA256:FarHostKey/);
    assert.doesNotMatch(first.text, /Are you sure|Permanently added/);
    assert.equal(pinned.length, 1);
    assert.match(pinned[0]!, /^SHA256:/);

    // Same key as pinned: connects, and nothing new is reported.
    const again: string[] = [];
    const second = await run(target(srv.port, pinned[0]), (fp) => again.push(fp));
    assert.equal(second.ok, true, second.text);
    assert.equal(again.length, 0);

    // A different pinned key (server rebuilt, or interception): refused before auth.
    const third = await run(target(srv.port, 'SHA256:somethingElseEntirely'));
    assert.equal(third.ok, false);
    assert.match(third.text, /host key changed/);
    assert.match(third.text, /Forget host key/);
  } finally {
    srv.close();
  }
});
