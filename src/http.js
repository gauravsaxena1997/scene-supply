export async function getJson(url, headers = {}) {
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`Remote service returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('Remote service returned invalid JSON');
  }
}

export function safeHttpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS downloads are allowed');
  if (url.username || url.password) throw new Error('Credentialed URLs are not allowed');
  return url;
}
