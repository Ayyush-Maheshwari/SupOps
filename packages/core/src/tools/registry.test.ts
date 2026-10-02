import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedTarget, ToolDef } from './types.ts';
import { sshExecTool } from './builtin.ts';
import { bindTool, bindTools } from './registry.ts';

const def = sshExecTool as unknown as ToolDef<never>;

const target = (slug: string, kind: ResolvedTarget['kind'] = 'ssh'): ResolvedTarget => ({
  id: `id-${slug}`,
  slug,
  kind,
  env: 'staging',
  sensitivity: 1,
  description: `${slug} box`,
  config: { kind: 'ssh', host: '10.0.0.1', port: 22, user: 'ops', sudo: false },
  credentialId: null,
  protectedPaths: null,
  writablePaths: null,
  unitAllowlist: null,
});

const enumOf = (spec: { function: { parameters: { properties?: Record<string, { enum?: string[] }> } } }) =>
  spec.function.parameters.properties?.target?.enum;

/**
 * Scoping a run is enforced by what the model is *given*, not by what it is told.
 * A target that was not selected has no representation in the tool schema, so the
 * agent cannot name it even if the task text asks it to.
 */
test('a bound tool exposes exactly the targets it was given', () => {
  const all = [target('uat'), target('db-1'), target('k3master')];
  assert.deepEqual(enumOf(bindTool(def, all)!.spec), ['uat', 'db-1', 'k3master']);

  const scoped = bindTool(def, [all[0]!])!;
  assert.deepEqual(enumOf(scoped.spec), ['uat']);
  assert.deepEqual([...scoped.targetsBySlug.keys()], ['uat'], 'execution lookup is scoped too');
});

test('the target description reaches the model, so it can choose sensibly', () => {
  const bound = bindTool(def, [target('uat')])!;
  const description = bound.spec.function.parameters.properties?.target?.description ?? '';
  assert.match(description, /uat/);
  assert.match(description, /uat box/);
});

test('a tool with no eligible target is dropped rather than offered empty', () => {
  // An unusable tool is pure noise in the prompt, and every extra tool measurably
  // degrades tool-call accuracy on smaller models.
  assert.equal(bindTool(def, [target('web', 'http')]), null);
  assert.deepEqual(bindTools([def], [target('web', 'http')]), []);
});

test('bound tools are ordered deterministically', () => {
  const targets = [target('uat')];
  const a = bindTools([def], targets).map((t) => t.def.key);
  const b = bindTools([def], targets).map((t) => t.def.key);
  assert.deepEqual(a, b);
});
