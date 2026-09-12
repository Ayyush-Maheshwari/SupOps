import OpenAI from 'openai';
import type { AssistantMessage, ChatMessage, ToolCallRequest, ToolSpec } from '@supops/shared';
import { assertConversationValid } from '@supops/shared';
import { FatalLLMError, RetryableLLMError } from './errors.ts';

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Cheap/fast model for the risk classifier's fallback path only. */
  classifierModel?: string;
  maxRetries?: number;
}

export interface CompletionResult {
  message: AssistantMessage;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * One client for every backend we care about.
 *
 * Gemini's free tier, Ollama, vLLM, LM Studio, LiteLLM and OpenRouter all speak
 * OpenAI-compatible `/chat/completions`, so switching providers -- including the
 * eventual move to a self-hosted model -- is a base URL and a model name, not a
 * code change. Two rules follow from that and are deliberately enforced here:
 *
 *  - Never send `tool_choice`. Ollama does not implement it, and a backend that
 *    ignores a parameter you are relying on fails open, silently.
 *  - Never rely on server-side conversation state (Gemini's `previous_interaction_id`
 *    and friends). SQLite is the only source of truth; we always send full history.
 */
export class LLMClient {
  private client: OpenAI;
  private current: LLMConfig;

  constructor(config: LLMConfig) {
    this.current = config;
    this.client = LLMClient.build(config);
  }

  private static build(config: LLMConfig): OpenAI {
    return new OpenAI({
      // Some OpenAI-compatible servers (Ollama among them) require the header to be
      // present but ignore its value, and the SDK refuses to start without one.
      apiKey: config.apiKey || 'not-set',
      baseURL: config.baseUrl,
      // We own retries, because a retry must also be able to suspend the run.
      maxRetries: 0,
    });
  }

  get config(): LLMConfig {
    return this.current;
  }

  /**
   * Swap the provider at runtime.
   *
   * Changing where the platform sends its requests should not require a restart --
   * that is the difference between "try a local model" being an experiment and being
   * a chore. In-flight requests keep the client they started with; the next call
   * uses the new one.
   */
  reconfigure(config: LLMConfig): void {
    this.current = config;
    this.client = LLMClient.build(config);
  }

  /**
   * One turn. Throws RetryableLLMError (caller should back off and resume) or
   * FatalLLMError (caller should fail the run).
   */
  async complete(
    messages: ChatMessage[],
    tools: ToolSpec[],
    opts: { model?: string; maxTokens?: number; temperature?: number } = {},
  ): Promise<CompletionResult> {
    // Cheap insurance against the single most damaging class of bug in this engine:
    // a suspend/resume path that produced a history the provider will reject, or
    // worse, quietly accept and degrade on.
    assertConversationValid(messages);

    const started = Date.now();
    let raw;
    try {
      raw = await this.client.chat.completions.create({
        model: opts.model ?? this.config.model,
        messages: messages as OpenAI.ChatCompletionMessageParam[],
        ...(tools.length ? { tools: tools as unknown as OpenAI.ChatCompletionTool[] } : {}),
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0,
      });
    } catch (err) {
      throw normaliseError(err);
    }

    const choice = raw.choices[0];
    if (!choice) throw new FatalLLMError('Provider returned no choices');

    return {
      message: toAssistantMessage(choice.message),
      finishReason: choice.finish_reason ?? 'stop',
      promptTokens: raw.usage?.prompt_tokens ?? 0,
      completionTokens: raw.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }

  /** Liveness + credential check for the settings screen. */
  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.complete([{ role: 'user', content: 'Reply with: ok' }], [], {
        maxTokens: 16,
      });
      return { ok: true, detail: (res.message.content ?? '').trim().slice(0, 80) || 'ok' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Normalise the provider's message into our canonical wire shape.
 *
 * Deliberately additive: every field the provider sent on a tool call is carried
 * through untouched. Rebuilding the object from just the fields we happen to care
 * about is what broke Gemini multi-turn tool use -- it drops
 * `extra_content.google.thought_signature`, which Gemini requires back on the next
 * request and 400s without.
 */
function toAssistantMessage(m: OpenAI.ChatCompletionMessage): AssistantMessage {
  const toolCalls: ToolCallRequest[] = (m.tool_calls ?? [])
    .filter((c): c is OpenAI.ChatCompletionMessageToolCall => c.type === 'function')
    .map((c) => ({
      ...(c as unknown as Record<string, unknown>),
      id: c.id,
      type: 'function' as const,
      function: { name: c.function.name, arguments: c.function.arguments },
    }));

  const out: AssistantMessage = { role: 'assistant', content: m.content ?? null };
  if (toolCalls.length) out.tool_calls = toolCalls;
  return out;
}

function normaliseError(err: unknown): Error {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const detail = describeApiError(err);
    if (status !== undefined && RETRYABLE_STATUS.has(status)) {
      return new RetryableLLMError(`Provider returned ${status}: ${detail}`, status, retryAfterMs(err));
    }
    return new FatalLLMError(`Provider returned ${status ?? '?'}: ${detail}`, status);
  }
  if (err instanceof OpenAI.APIConnectionError || isNetworkError(err)) {
    return new RetryableLLMError(
      `Could not reach the provider: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      DEFAULT_BACKOFF_MS,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

function isNetworkError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN'
  );
}

/** Honour the provider's own advice before falling back to our default. */
function retryAfterMs(err: InstanceType<typeof OpenAI.APIError>): number {
  const header = err.headers?.['retry-after'] ?? err.headers?.['Retry-After'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
    const at = Date.parse(String(raw));
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_BACKOFF_MS);
  }
  // Some providers state the delay in the message body instead of a header.
  const hint = /retry in ([0-9.]+)(ms|s)?/i.exec(describeApiError(err));
  if (hint) {
    const value = Number(hint[1]);
    const ms = hint[2] === 's' ? value * 1000 : value;
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_BACKOFF_MS);
  }
  return DEFAULT_BACKOFF_MS;
}

/**
 * Pull the provider's own explanation out of the error.
 *
 * The SDK's `message` for a 4xx is often just "400 status code (no body)", which
 * tells an operator nothing and makes a misconfiguration indistinguishable from a
 * bug. The actual reason is almost always in the parsed response body, so dig it out
 * and put it in the message that reaches the run's status.
 */
function describeApiError(err: InstanceType<typeof OpenAI.APIError>): string {
  // Gemini returns errors as a JSON *array* of objects, which the SDK does not
  // unwrap -- so `err.message` degrades to "429 status code (no body)" and the real
  // explanation ("Quota exceeded ... limit: 20") is thrown away. Unwrap it.
  const raw = Array.isArray(err.error) ? err.error[0] : err.error;
  const body = raw as
    | { message?: string; error?: { message?: string; status?: string } }
    | string
    | undefined;

  const message =
    typeof body === 'string'
      ? body
      : (body?.error?.message ?? body?.message);

  if (message) return String(message).replace(/\s+/g, ' ').slice(0, 500);
  if (body && typeof body === 'object') return JSON.stringify(body).slice(0, 500);
  return err.message;
}

/** Exponential backoff with jitter, for attempts our own loop schedules. */
export function backoffMs(attempt: number, baseMs = DEFAULT_BACKOFF_MS): number {
  const exp = Math.min(baseMs * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}
