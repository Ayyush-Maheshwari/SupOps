import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierRank } from '@supops/shared';
import { classifyShellCommand } from './shell.ts';
import { withRiskRulesMode } from './shell-rules.ts';
import { CORPUS, LOWERED, PROD, STAGING } from './corpus.ts';

const v2 = (c: string, t = STAGING) => withRiskRulesMode('v2', () => classifyShellCommand(c, t));
const legacy = (c: string, t = STAGING) => withRiskRulesMode('legacy', () => classifyShellCommand(c, t));

for (const [cmd, expected] of CORPUS) {
  test(`[${expected}] ${cmd}`, () => {
    const got = v2(cmd);
    assert.equal(got.tier, expected, `rules fired:\n${got.contributions.map((c) => `  - ${c.ruleId}: ${c.reason}`).join('\n')}`);
  });
}

test('the current rules are never looser than legacy, except where listed', () => {
  const looser: string[] = [];
  for (const [cmd] of CORPUS) {
    for (const t of [STAGING, PROD]) {
      const now = v2(cmd, t).tier;
      const before = legacy(cmd, t).tier;
      if (tierRank(now) < tierRank(before) && !(cmd in LOWERED)) looser.push(`${t.env}: ${cmd} (${before} -> ${now})`);
    }
  }
  assert.deepEqual(looser, []);
});

test('every LOWERED entry is in the corpus', () => {
  const known = new Set(CORPUS.map(([c]) => c));
  assert.deepEqual(Object.keys(LOWERED).filter((c) => !known.has(c)), []);
});

test('production is never looser than staging', () => {
  for (const [cmd] of CORPUS) {
    assert.ok(tierRank(v2(cmd, PROD).tier) >= tierRank(v2(cmd, STAGING).tier), cmd);
  }
});

test('every non-read verdict explains itself and names its harm', () => {
  for (const [cmd, expected] of CORPUS) {
    if (expected === 'read_only') continue;
    const { contributions } = v2(cmd);
    const top = contributions.filter((c) => c.tier === expected);
    assert.ok(top.length && top.every((c) => c.reason.length > 0), cmd);
  }
});

test('SUPOPS_RISK_RULES=legacy restores the legacy rules exactly', () => {
  const prev = process.env.SUPOPS_RISK_RULES;
  try {
    process.env.SUPOPS_RISK_RULES = 'legacy';
    for (const [cmd] of CORPUS) {
      assert.equal(classifyShellCommand(cmd, STAGING).tier, legacy(cmd).tier, cmd);
    }
  } finally {
    if (prev === undefined) delete process.env.SUPOPS_RISK_RULES;
    else process.env.SUPOPS_RISK_RULES = prev;
  }
});
