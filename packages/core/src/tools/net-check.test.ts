import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { guarded, NETWORK_TARGET, netCheckTool } from './net-check.ts';

const tierOf = (args: Record<string, unknown>) => {
  const a = netCheckTool.argsSchema.parse({ target: NETWORK_TARGET.slug, ...args });
  return netCheckTool.classifyArgs!(a, NETWORK_TARGET)[0]!.tier;
};
const run = (args: Record<string, unknown>) =>
  netCheckTool.execute(netCheckTool.argsSchema.parse({ target: NETWORK_TARGET.slug, ...args }), {
    runId: 'r', toolCallId: 't', target: NETWORK_TARGET, timeoutMs: 20_000, maxOutputBytes: 100_000, signal: new AbortController().signal,
  });

test('public checks are read-only, internal ones need approval, metadata is never allowed', () => {
  assert.equal(tierOf({ check: 'http', url: 'https://example.com/health' }), 'read_only');
  assert.equal(tierOf({ check: 'dns', host: 'example.com', record_type: 'MX' }), 'read_only');
  assert.equal(tierOf({ check: 'tcp', host: '10.0.0.5', port: 5432 }), 'medium');
  assert.equal(tierOf({ check: 'ping', host: 'db.internal' }), 'medium');
  assert.equal(tierOf({ check: 'ping', host: 'localhost' }), 'medium');
  assert.equal(tierOf({ check: 'http', url: 'https://example.com', allow_private: true }), 'medium');
  assert.equal(tierOf({ check: 'http', url: 'http://169.254.169.254/latest/meta-data/' }), 'forbidden');
});

test('arguments are validated: what each check needs, and nothing option-like as a host', () => {
  const bad = (a: Record<string, unknown>) => !netCheckTool.argsSchema.safeParse({ target: 's', ...a }).success;
  assert.ok(bad({ check: 'http' }), 'http needs a url');
  assert.ok(bad({ check: 'tcp', host: 'example.com' }), 'tcp needs a port');
  assert.ok(bad({ check: 'ping', host: '-f example.com' }), 'no options smuggled in as a host');
  assert.ok(bad({ check: 'ping', host: 'a;rm -rf /' }));
  assert.ok(!bad({ check: 'ping', host: '2001:db8::1' }));
  assert.ok(bad({ check: 'http', url: 'https://x', method: 'POST' }), 'GET and HEAD only');
});

test('an internal address is refused at connect time unless the call allowed it', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/go') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain', server: 'test' });
    res.end('all good');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  try {
    const refused = await run({ check: 'http', url: `http://127.0.0.1:${port}/go`, allow_private: false });
    assert.equal(tierOf({ check: 'http', url: `http://127.0.0.1:${port}/go` }), 'medium', 'an internal IP always asks first');
    assert.equal(refused.ok, true, 'and once approved it runs');

    const allowed = await run({ check: 'http', url: `http://127.0.0.1:${port}/go`, allow_private: true });
    assert.equal(allowed.ok, true, allowed.text);
    assert.match(allowed.text, /HTTP 302/);
    assert.match(allowed.text, /\/ok -> HTTP 200/);
    assert.match(allowed.text, /all good/);
    assert.match(allowed.text, /Redirects: 1/);

    const open = await run({ check: 'tcp', host: '127.0.0.1', port, allow_private: true });
    assert.match(open.text, /is OPEN/);
    // A plainly internal host already needs approval, so once approved it runs.
    assert.equal(tierOf({ check: 'tcp', host: '127.0.0.1', port }), 'medium');
    const approved = await run({ check: 'tcp', host: '127.0.0.1', port });
    assert.match(approved.text, /is OPEN/);
  } finally {
    srv.close();
  }
  const closed = await run({ check: 'tcp', host: '127.0.0.1', port: 1, allow_private: true });
  assert.equal(closed.ok, false);
  assert.match(closed.text, /ECONNREFUSED/);
});

test('the connect-time guard refuses a name that resolves internally unless allowed', async () => {
  // How a public-looking name that resolves to an internal address is caught: it was
  // classified read-only, so it may not reach the internal address it turns out to be.
  const lookup = (allow: boolean, all: boolean) =>
    new Promise<{ err: Error | null; addr: unknown }>((resolve) =>
      guarded(allow)('localhost', { all, family: 4 }, (err, addr) => resolve({ err, addr })),
    );
  const refused = await lookup(false, true);
  assert.match(String(refused.err?.message), /resolves to 127\.0\.0\.1, an internal address/);
  // Node's connection racing asks for every address at once; a single answer breaks it.
  const all = await lookup(true, true);
  assert.equal(all.err, null);
  assert.ok(Array.isArray(all.addr) && (all.addr as Array<{ address: string }>)[0]!.address === '127.0.0.1');
  const one = await lookup(true, false);
  assert.equal(one.addr, '127.0.0.1');
});

test('a hostname check runs end to end through the guarded lookup', async () => {
  const srv = createServer((_q, res) => res.end('hi'));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  try {
    const viaHttp = await run({ check: 'http', url: `http://localhost:${port}/` });
    assert.equal(viaHttp.ok, true, viaHttp.text);
    assert.match(viaHttp.text, /HTTP 200/);
    assert.equal(tierOf({ check: 'http', url: `http://localhost:${port}/` }), 'medium', 'localhost asks first');
  } finally {
    srv.close();
  }
});

test('metadata stays unreachable even when internal addresses are allowed', async () => {
  const r = await run({ check: 'http', url: 'http://169.254.169.254/latest/meta-data/', allow_private: true });
  assert.equal(r.ok, false);
  assert.match(r.text, /never contacted/);
});
