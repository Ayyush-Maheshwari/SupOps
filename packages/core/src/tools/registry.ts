import { assertSchemaProfile } from '@supops/shared';
import type { JsonSchemaProfile, ToolSpec } from '@supops/shared';
import type { ResolvedTarget, ResolvedTool, ToolDef } from './types.ts';

/**
 * Bind a tool to a project's targets.
 *
 * This is where "project-agnostic" stops being a slogan. There is one `ssh_exec`
 * tool, never `ssh_exec__prod_web_1`: the target is an enum generated from what
 * this project has registered. A host in someone else's project is not merely
 * denied, it is unrepresentable in the tool schema -- which is the cheapest
 * enforcement available and costs nothing at runtime.
 *
 * The enum is a nudge, not a boundary. `validateArgs` re-checks the slug server-side,
 * because small models cheerfully invent enum values.
 */
export function bindTool(
  def: ToolDef<never>,
  targets: ResolvedTarget[],
): ResolvedTool | null {
  const eligible = targets.filter((t) => def.targetKinds.includes(t.kind));
  // A tool with no target to act on is noise in the prompt, and every extra tool
  // measurably degrades tool-call accuracy on smaller models. Drop it.
  if (eligible.length === 0) return null;

  const properties: Record<string, JsonSchemaProfile> = {
    target: {
      type: 'string',
      enum: eligible.map((t) => t.slug),
      description:
        'Which registered target to act on. Available:\n' +
        eligible
          .map((t) => `- ${t.slug} (${t.kind}, env=${t.env})${t.description ? `: ${t.description}` : ''}`)
          .join('\n'),
    },
    ...def.parameters,
  };

  const parameters: JsonSchemaProfile = {
    type: 'object',
    properties,
    required: ['target', ...def.required],
  };

  // Fail at bind time, not at request time: a dropped constraint fails open.
  assertSchemaProfile(parameters, `${def.key}.parameters`);

  const spec: ToolSpec = {
    type: 'function',
    function: { name: def.key, description: def.description, parameters },
  };

  return {
    def,
    spec,
    targetsBySlug: new Map(eligible.map((t) => [t.slug, t])),
  };
}

/** Deterministic ordering keeps the serialised tool list stable across runs. */
export function bindTools(
  defs: ToolDef<never>[],
  targets: ResolvedTarget[],
): ResolvedTool[] {
  return defs
    .map((d) => bindTool(d, targets))
    .filter((t): t is ResolvedTool => t !== null)
    .sort((a, b) => a.def.key.localeCompare(b.def.key));
}

export class ToolRegistry {
  private byKey = new Map<string, ToolDef<never>>();

  register(def: ToolDef<never>): this {
    if (this.byKey.has(def.key)) throw new Error(`Duplicate tool key "${def.key}"`);
    this.byKey.set(def.key, def);
    return this;
  }

  get(key: string): ToolDef<never> | undefined {
    return this.byKey.get(key);
  }

  /**
   * Resolve the effective allowlist. Deny by default: a tool the agent did not
   * explicitly list is not available, and an unknown key is an error rather than a
   * silent omission, because silently shipping fewer tools than intended is very
   * hard to notice from the outside.
   */
  resolve(allowedKeys: string[] | null): ToolDef<never>[] {
    const base =
      allowedKeys === null
        ? [...this.byKey.values()]
        : allowedKeys.map((k) => {
            const def = this.byKey.get(k);
            if (!def) throw new Error(`Agent references unknown tool "${k}"`);
            return def;
          });
    // Always-available tools an agent gets regardless of its allowlist. `confirm_target`
    // is a safety affordance (confirm which machine before acting), so agents created
    // before it existed still get it without editing their stored tool list.
    for (const key of ToolRegistry.MANDATORY) {
      const def = this.byKey.get(key);
      if (def && !base.some((d) => d.key === key)) base.push(def);
    }
    return base;
  }

  private static readonly MANDATORY = ['confirm_target'];

  keys(): string[] {
    return [...this.byKey.keys()];
  }
}
