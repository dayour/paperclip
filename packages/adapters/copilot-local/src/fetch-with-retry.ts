// ---------------------------------------------------------------------------
// fetchWithRetry — generic HTTP retry with exponential backoff
//
// Vendored locally inside the copilot_local adapter so this package does not
// depend on a newer adapter-utils export. Mirrors the helper available in
// upstream @paperclipai/adapter-utils/server-utils > 0.x.
// ---------------------------------------------------------------------------

export interface FetchRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableStatuses?: number[];
  onRetry?: (info: {
    attempt: number;
    maxRetries: number;
    status: number;
    delayMs: number;
    retryAfterHeader?: string | null;
  }) => void | Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_RETRYABLE_STATUSES = [429, 502, 503, 504];

export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const {
    maxRetries = 3,
    baseDelayMs = 2000,
    maxDelayMs = 30_000,
    retryableStatuses = DEFAULT_RETRYABLE_STATUSES,
    onRetry,
    timeoutMs,
  } = options;

  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs && timeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => controller!.abort(), timeoutMs);
    }

    const signals: AbortSignal[] = [];
    if (controller?.signal) signals.push(controller.signal);
    if (init.signal) signals.push(init.signal as AbortSignal);
    const signal =
      signals.length > 1
        ? AbortSignal.any(signals)
        : signals[0] ?? undefined;

    try {
      lastResponse = await fetch(url, { ...init, signal });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (lastResponse.ok) return lastResponse;

    if (!retryableStatuses.includes(lastResponse.status) || attempt >= maxRetries) {
      return lastResponse;
    }

    const retryAfter = lastResponse.headers.get("retry-after");
    let delayMs = baseDelayMs * Math.pow(2, attempt);

    if (retryAfter) {
      const parsed = Number(retryAfter);
      if (!Number.isNaN(parsed) && parsed > 0) {
        delayMs = parsed * 1000;
      } else {
        const date = new Date(retryAfter).getTime();
        if (!Number.isNaN(date)) {
          delayMs = Math.max(0, date - Date.now());
        }
      }
    }

    delayMs = Math.min(delayMs, maxDelayMs);

    try { await lastResponse.text(); } catch { /* ignore */ }

    if (onRetry) {
      await onRetry({
        attempt: attempt + 1,
        maxRetries,
        status: lastResponse.status,
        delayMs,
        retryAfterHeader: retryAfter,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return lastResponse!;
}
