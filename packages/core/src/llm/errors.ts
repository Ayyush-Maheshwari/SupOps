/**
 * A transient provider failure. The engine parks the run in `suspended` with
 * `resumeAfter` persisted, so a long backoff survives a process restart instead of
 * living in a `setTimeout` that a deploy would silently discard.
 */
export class RetryableLLMError extends Error {
  status: number | undefined;
  retryAfterMs: number;

  constructor(message: string, status: number | undefined, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableLLMError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The provider rejected the request and retrying it unchanged will not help. */
export class FatalLLMError extends Error {
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'FatalLLMError';
    this.status = status;
  }
}
