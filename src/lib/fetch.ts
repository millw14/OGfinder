export async function fetchWithTimeout(
  url: string,
  ms: number,
  init?: RequestInit
): Promise<unknown> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}
