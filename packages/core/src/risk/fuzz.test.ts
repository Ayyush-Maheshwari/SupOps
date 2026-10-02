import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISK_TIERS, tierRank } from '@supops/shared';
import { classifyShellCommand } from './shell.ts';
import { lexShell } from './shell-lex.ts';
import { CORPUS, STAGING } from './corpus.ts';

/** Small deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE = [...`'"\`$(){}[]|;&<>\\ \t\n*?~!#=-`, '​', '‮', ' ', 'é'];
const cmds = CORPUS.map(([c]) => c);

function mutate(r: () => number, s: string): string {
  const pos = Math.floor(r() * (s.length + 1));
  switch (Math.floor(r() * 4)) {
    case 0: return s.slice(0, pos) + NOISE[Math.floor(r() * NOISE.length)]! + s.slice(pos);
    case 1: return s.slice(0, pos) + s.slice(pos + 1);
    case 2: return s.slice(0, pos) + s.slice(pos, pos + 1).repeat(2) + s.slice(pos + 1);
    default: return `${s} ${cmds[Math.floor(r() * cmds.length)]!}`;
  }
}

test('5000 mutated lines: never throws, always a valid tier, unreadable lines are at least high', () => {
  const r = rng(20260928);
  for (let i = 0; i < 5000; i += 1) {
    let line = cmds[Math.floor(r() * cmds.length)]!;
    for (let k = 1 + Math.floor(r() * 3); k > 0; k -= 1) line = mutate(r, line);
    const verdict = classifyShellCommand(line, STAGING);
    assert.ok(RISK_TIERS.includes(verdict.tier), `invalid tier for ${JSON.stringify(line)}`);
    if (!lexShell(line).ok) {
      assert.ok(tierRank(verdict.tier) >= tierRank('high'), `unreadable but ${verdict.tier}: ${JSON.stringify(line)}`);
    }
  }
});

test('joining commands never lowers the stricter one', () => {
  const r = rng(7);
  for (let i = 0; i < 1500; i += 1) {
    const [a, ta] = CORPUS[Math.floor(r() * CORPUS.length)]!;
    const [b, tb] = CORPUS[Math.floor(r() * CORPUS.length)]!;
    const op = ['; ', ' && ', ' || '][Math.floor(r() * 3)]!;
    const joined = classifyShellCommand(`${a}${op}${b}`, STAGING).tier;
    const floor = tierRank(ta) >= tierRank(tb) ? ta : tb;
    assert.ok(tierRank(joined) >= tierRank(floor), `${a}${op}${b}: ${joined} < ${floor}`);
  }
});
