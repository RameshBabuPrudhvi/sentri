export async function generate(ctx, deps) {
  const { MAX_RETRIES, BASE_DELAY_MS, MAX_BACKOFF_MS, callOllama, sleep, formatLogLine } = deps;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await callOllama(ctx.messages.combined, ctx.maxTokens, ctx.signal, ctx.useJson);
      return { text, usage: null };
    } catch (err) {
      if (err.name === "AbortError" || ctx.signal?.aborted) throw err;
      const isRetryable = err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed") || err.message.includes("Ollama HTTP 500");
      if (attempt === MAX_RETRIES || !isRetryable) throw err;
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      console.warn(formatLogLine("warn", null, `[Ollama] ${err.message.slice(0, 80)}. Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`));
      await sleep(delay);
    }
  }
  return { text: "", usage: null };
}

export async function stream() { return null; }
export async function generateVision() { return null; }
