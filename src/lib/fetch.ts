export async function fetchWithTimeout(
  url: string,
  ms: number,
  init?: RequestInit
): Promise<unknown> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      // No URL in the message — some endpoints carry API keys in the query string.
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}
