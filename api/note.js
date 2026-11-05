// One optional line from someone who tried the /try page. It only goes to the server log.
const seen = new Map();
export async function POST(request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const recent = (seen.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= 10) return new Response(null, { status: 429 });
  seen.set(ip, [...recent, now]);
  if (seen.size > 5000) seen.delete(seen.keys().next().value);
  const body = await request.json().catch(() => ({}));
  const text = String(body?.text || '').trim().slice(0, 300);
  const project = /^[0-9a-f-]{36}$/.test(body?.project || '') ? body.project : null;
  if (text) console.log('[AR] note', JSON.stringify({ project, text }));
  return new Response(null, { status: 204 });
}
