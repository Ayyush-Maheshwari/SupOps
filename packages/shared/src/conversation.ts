import type { ChatMessage } from './chat.ts';

export class ConversationInvariantError extends Error {
  /** Index of the offending message, for the failure dump. */
  index: number;

  constructor(message: string, index: number) {
    super(`Conversation invariant violated at message[${index}]: ${message}`);
    this.name = 'ConversationInvariantError';
    this.index = index;
  }
}

/**
 * Invariant A, enforced. Call this before EVERY request to the model.
 *
 * A malformed history is the single most likely way this engine breaks, and the
 * failure is insidious: some backends reject it with a 400, but others accept it
 * and quietly produce a worse agent (it stops emitting parallel tool calls, or
 * hallucinates the result it never received). Either way the cause is a suspend/
 * resume bug written hours earlier, so we check at the point of use rather than
 * trusting the writer.
 *
 * Rules:
 *  1. An assistant message with N tool_calls is followed by exactly N `role:"tool"`
 *     messages -- one per tool_call_id, in the same order, contiguously.
 *  2. No orphan `role:"tool"` message.
 *  3. tool_call ids are unique across the conversation.
 *  4. The conversation does not start with a `role:"tool"` message.
 */
export function assertConversationValid(messages: ChatMessage[]): void {
  const seenIds = new Set<string>();
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === 'tool') {
      throw new ConversationInvariantError(
        `orphan tool message for tool_call_id "${msg.tool_call_id}" -- ` +
          `it does not follow an assistant message that requested it`,
        i,
      );
    }

    if (msg.role !== 'assistant' || !msg.tool_calls?.length) {
      i += 1;
      continue;
    }

    const expected = msg.tool_calls;
    for (const call of expected) {
      if (seenIds.has(call.id)) {
        throw new ConversationInvariantError(`duplicate tool_call id "${call.id}"`, i);
      }
      seenIds.add(call.id);
    }

    // Exactly N replies must follow, in order.
    for (let k = 0; k < expected.length; k += 1) {
      const reply = messages[i + 1 + k];
      const call = expected[k]!;

      if (!reply) {
        throw new ConversationInvariantError(
          `assistant requested ${expected.length} tool call(s) but the conversation ` +
            `ends after ${k}. Missing a reply for "${call.function.name}" (${call.id}). ` +
            `A tool-result step must be materialised all-at-once, only when every ` +
            `sibling call is terminal.`,
          i,
        );
      }
      if (reply.role !== 'tool') {
        throw new ConversationInvariantError(
          `expected a tool reply for "${call.function.name}" (${call.id}) but found ` +
            `role "${reply.role}"`,
          i + 1 + k,
        );
      }
      if (reply.tool_call_id !== call.id) {
        throw new ConversationInvariantError(
          `tool reply out of order: expected tool_call_id "${call.id}" ` +
            `(${call.function.name}) but found "${reply.tool_call_id}"`,
          i + 1 + k,
        );
      }
    }

    i += 1 + expected.length;
  }
}

/** Non-throwing variant for logging and UI. */
export function conversationError(messages: ChatMessage[]): string | null {
  try {
    assertConversationValid(messages);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
