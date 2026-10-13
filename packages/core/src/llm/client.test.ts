import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LLMClient } from './client.ts';
import { FatalLLMError, RetryableLLMError } from './errors.ts';

/** A fake OpenAI-compatible provider: `answer` decides the status for each request body. */
async function provider(answer: (body: Record<string, unknown>) => number) {
  const seen: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push(body);
      const status = answer(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        status === 200
          ? JSON.stringify({ choices: [{ message: { role: 'assistant', content: `hi from ${body.model}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })
          : JSON.stringify([{ error: { code: status, message: `failure ${status}`, status: 'X' } }]),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { seen, baseUrl: `http://127.0.0.1:${port}/v1/`, close: () => new Promise((r) => server.close(r)) };
}

const ask = [{ role: 'user' as const, content: 'hello' }];

test('a model that rejects temperature is retried without it, and called without it from then on', async () => {
  const p = await provider((b) => ('temperature' in b ? 500 : 200));
  try {
    const llm = new LLMClient({ baseUrl: p.baseUrl, apiKey: 'k', model: 'gemini-new' });
    const first = await llm.complete(ask, []);
    assert.equal(first.message.content, 'hi from gemini-new');
    assert.deepEqual(p.seen.map((b) => 'temperature' in b), [true, false]);
    await llm.complete(ask, []);
    assert.equal(p.seen.length, 3);
    assert.equal('temperature' in p.seen[2]!, false);
  } finally {
    await p.close();
  }
});

test('a failure that is not about temperature reports the original error', async () => {
  const p = await provider(() => 503);
  try {
    const llm = new LLMClient({ baseUrl: p.baseUrl, apiKey: 'k', model: 'm' });
    await assert.rejects(llm.complete(ask, []), (e: unknown) => e instanceof RetryableLLMError && e.status === 503);
    assert.equal(p.seen.length, 1, '503 is not a sampling rejection: no second request');
  } finally {
    await p.close();
  }
});

test('the fallback model answers when the main one is overloaded, and says so', async () => {
  const p = await provider((b) => (b.model === 'main' ? 503 : 200));
  try {
    const llm = new LLMClient({ baseUrl: p.baseUrl, apiKey: 'k', model: 'main', fallbackModel: 'backup' });
    const r = await llm.complete(ask, []);
    assert.equal(r.model, 'backup');
    assert.equal(r.message.content, 'hi from backup');
    assert.equal(r.fellBackFrom?.model, 'main');
    assert.match(r.fellBackFrom?.error ?? '', /503/);
  } finally {
    await p.close();
  }
});

test('a run, which always names its model, falls back too', async () => {
  const p = await provider((b) => (b.model === 'main' ? 503 : 200));
  try {
    const llm = new LLMClient({ baseUrl: p.baseUrl, apiKey: 'k', model: 'main', fallbackModel: 'backup' });
    // exactly how the engine calls it: the model the run started with
    const r = await llm.complete(ask, [], { model: 'main', maxTokens: 8192 });
    assert.equal(r.model, 'backup');
  } finally {
    await p.close();
  }
});

test('no fallback for a bad key, when asked for none, or when the fallback fails too', async () => {
  const p = await provider((b) => (b.model === 'main' ? 401 : b.model === 'dead' ? 500 : 503));
  try {
    const bad = new LLMClient({ baseUrl: p.baseUrl, apiKey: 'k', model: 'main', fallbackModel: 'backup' });
    await assert.rejects(bad.complete(ask, []), (e: unknown) => e instanceof FatalLLMError && e.status === 401);
    assert.ok(!p.seen.some((b) => b.model === 'backup'), 'a bad key is not a model problem');

    const exact = new LLMClient({ baseUrl: p.baseUrl, apiKey: 'k', model: 'x', fallbackModel: 'backup' });
    await assert.rejects(exact.complete(ask, [], { model: 'dead', noFallback: true }));
    assert.ok(!p.seen.some((b) => b.model === 'backup'), 'noFallback means that model or nothing');

    // main 503, fallback 'dead' 500 (and 500 again without temperature): the main error is reported
    const both = new LLMClient({ baseUrl: p.baseUrl, apiKey: 'k', model: 'other', fallbackModel: 'dead' });
    await assert.rejects(both.complete(ask, []), (e: unknown) => e instanceof RetryableLLMError && e.status === 503);
  } finally {
    await p.close();
  }
});

test('the connection test checks the main model on its own, then the fallback', async () => {
  const p = await provider((b) => (b.model === 'main' ? 404 : 200));
  try {
    const llm = new LLMClient({ baseUrl: p.baseUrl, apiKey: 'k', model: 'main', fallbackModel: 'backup' });
    const r = await llm.ping();
    assert.equal(r.ok, false, 'a working fallback must not hide a broken main model');
    assert.match(r.detail, /404/);
    assert.equal(r.fallback?.ok, true);
  } finally {
    await p.close();
  }
});
