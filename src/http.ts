export async function send(portalUrl: string, token: string, payload: unknown) {
  const res = await fetch(portalUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[quollabore] HTTP ${res.status}: ${text}`);
  }
  return res.json().catch(() => ({}));
}
