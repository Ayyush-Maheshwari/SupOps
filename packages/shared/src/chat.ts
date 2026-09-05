/**
 * The canonical conversation format: OpenAI-compatible chat completions.
 *
 * This is the wire shape for Gemini's compat endpoint, Ollama, vLLM, LM Studio,
 * LiteLLM and OpenRouter alike -- which is the entire reason we chose it. A message
 * is persisted EXACTLY as it will be sent, so rebuilding a conversation from SQLite
 * is a `map`, not a re-derivation. Do not add fields a backend won't accept.
 */

export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** Raw JSON string as the model emitted it. Parse defensively; never trust it. */
    arguments: string;
  };
  /**
   * Provider-specific fields returned alongside the call, preserved verbatim.
   *
   * These are not decoration. Gemini 3 attaches
   * `extra_content.google.thought_signature` here and REJECTS the next request with
   * a 400 if it is not echoed back, so any normalisation that drops unknown keys
   * breaks multi-turn tool use entirely. The rule is the same one that governs
   * `run_steps.messageJson`: store what the provider sent, do not reconstruct it.
   */
  [providerSpecific: string]: unknown;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCallRequest[];
}

export interface ToolMessage {
  role: 'tool';
  tool_call_id: string;
  name?: string;
  content: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/**
 * JSON Schema, restricted to the lowest common denominator every backend accepts.
 *
 * Gemini's function declarations support only: type, properties, required,
 * description, enum, items. No additionalProperties, no oneOf/anyOf, no pattern,
 * no minLength/maximum. Local models honour even less.
 *
 * Anything richer is enforced by a zod schema server-side in `Executor.validate()`
 * and restated in the tool's `description`, which is the only channel the model
 * actually reads. See `assertSchemaProfile`.
 */
export interface JsonSchemaProfile {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchemaProfile>;
  required?: string[];
  enum?: string[];
  items?: JsonSchemaProfile;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchemaProfile;
  };
}

const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'enum',
  'items',
]);

/**
 * Fails loudly if a tool schema uses a JSON Schema feature some backend will choke
 * on or silently drop. Run in CI over every built-in and custom tool: a dropped
 * constraint is worse than a rejected one, because it fails open at runtime.
 */
export function assertSchemaProfile(schema: JsonSchemaProfile, path = 'parameters'): void {
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      throw new Error(
        `Tool schema at "${path}" uses unsupported JSON Schema key "${key}". ` +
          `Supported: ${[...ALLOWED_SCHEMA_KEYS].join(', ')}. ` +
          `Express this constraint in the zod validator and the tool description instead.`,
      );
    }
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    assertSchemaProfile(child, `${path}.${name}`);
  }
  if (schema.items) assertSchemaProfile(schema.items, `${path}[]`);
}

/** Marker that makes an error unmistakable to a small model. */
export const ERROR_PREFIX = 'ERROR:';

export const toolErrorMessage = (
  toolCallId: string,
  name: string,
  detail: string,
): ToolMessage => ({
  role: 'tool',
  tool_call_id: toolCallId,
  name,
  content: `${ERROR_PREFIX} ${detail}`,
});
