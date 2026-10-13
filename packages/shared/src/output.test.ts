import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnsiStripper, stripAnsi } from './output.ts';

const E = '\x1b';
// What `kubectl get pods -A | grep web` prints when grep colours its matches.
const grepped =
  `shop        shop-api-${E}[01;31m${E}[Kweb${E}[m${E}[K-958bd98bd-2zk8n      1/1     Running     0     7d23h\n` +
  `ingress     admission-${E}[01;31m${E}[Kweb${E}[m${E}[Khooks-58fd99db89-qx97h   1/1     Running     0     65d`;

test('colour codes from grep, ls and friends are removed, the text is kept', () => {
  assert.equal(
    stripAnsi(grepped),
    'shop        shop-api-web-958bd98bd-2zk8n      1/1     Running     0     7d23h\n' +
      'ingress     admission-webhooks-58fd99db89-qx97h   1/1     Running     0     65d',
  );
  assert.equal(stripAnsi(`${E}[1;34mdir${E}[0m  ${E}[32mrun.sh${E}[0m`), 'dir  run.sh');
  assert.equal(stripAnsi(`${E}]0;user@host: ~${E}\\prompt`), 'prompt', 'window titles too');
  assert.equal(stripAnsi(`${E}[?2004hready${E}[?2004l`), 'ready', 'bracketed paste mode');
});

test('text that only looks like a code, without the ESC byte, is left alone', () => {
  assert.equal(stripAnsi('array[01;31m] and [K]'), 'array[01;31m] and [K]');
});

test('a code split across streamed chunks is still removed', () => {
  const s = new AnsiStripper();
  const parts = [`api-${E}[01;3`, `1m${E}[Kweb${E}`, `[m${E}[K-pod\n`];
  const out = parts.map((p) => s.push(p)).join('') + s.flush();
  assert.equal(out, 'api-web-pod\n');
  // every chunk boundary
  for (let i = 1; i < grepped.length; i++) {
    const t = new AnsiStripper();
    assert.equal(t.push(grepped.slice(0, i)) + t.push(grepped.slice(i)) + t.flush(), stripAnsi(grepped));
  }
});
