/**
 * Replay a run's exact conversation against the configured provider and print the
 * raw response. Used to turn an opaque provider error into an actionable one.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { decryptSecret, unpackEnvelope, setMasterKey } from '../packages/db/src/crypto.ts';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
);
setMasterKey(Buffer.from(env.SUPOPS_MASTER_KEY, 'base64'));

const d = new Database('./data/supops.db');
const stored = d.prepare("SELECT value FROM settings WHERE key='llm'").get();
const cfg = stored ? JSON.parse(stored.value) : {};
const apiKey = cfg.apiKeyEnc ? decryptSecret(unpackEnvelope(cfg.apiKeyEnc)) : env.LLM_API_KEY;
const baseUrl = cfg.baseUrl || env.LLM_BASE_URL;
const model = cfg.model || env.LLM_MODEL;

const run = d.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get();
const messages = d
  .prepare("SELECT message_json FROM run_steps WHERE run_id=? AND state='committed' ORDER BY seq")
  .all(run.id)
  .map((r) => JSON.parse(r.message_json));
const tools = JSON.parse(run.tools_snapshot);

console.log(`  provider : ${baseUrl}`);
console.log(`  model    : ${model}`);
console.log(`  key      : ${apiKey ? apiKey.slice(0, 6) + '…' : 'NONE'}`);
console.log(`  messages : ${messages.map((m) => m.role).join(' -> ')}`);
console.log(`  tools    : ${tools.map((t) => t.function.name).join(', ')}`);
console.log('');

const res = await fetch(new URL('chat/completions', baseUrl), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ model, messages, tools, max_tokens: 1024, temperature: 0 }),
});

console.log(`  HTTP ${res.status}`);
console.log('  ' + (await res.text()).slice(0, 1500).replace(/\n/g, '\n  '));
