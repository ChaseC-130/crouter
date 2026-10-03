import "server-only";
import { UsageReadError } from "./claude-usage";

export class ProviderUsageError extends UsageReadError {
  constructor(
    public detail: string,
    retryAfterMs = 60000,
  ) {
    super(retryAfterMs);
    this.message = detail;
  }
}

// Fixed vendor endpoints are chosen by adapters, never by credential files or API responses.
export async function usageJson(
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ProviderUsageError(
      "Usage service could not be reached. Retry in a moment.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      throw new ProviderUsageError(
        "Saved CLI login was rejected. Sign in with the CLI and refresh limits.",
      );
    const retry = response.headers.get("retry-after");
    const delay =
      retry && /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : retry
          ? Date.parse(retry) - Date.now()
          : 60000;
    throw new ProviderUsageError(
      response.status === 429
        ? "Usage service is rate limited. Refresh will retry after the cooldown."
        : "Usage service could not refresh limits.",
      Number.isFinite(delay)
        ? Math.max(60000, Math.min(delay, 3600000))
        : 60000,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderUsageError("Usage service returned no data.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error("Response budget exceeded");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => {});
    throw new ProviderUsageError(
      "Usage service returned an unreadable response.",
    );
  } finally {
    reader.releaseLock();
  }
}
