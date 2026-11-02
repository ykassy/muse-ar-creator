// Talk to the AR character: the HACKAR:S player (Hand Play) pokes the character, records a short
// clip and posts it here. Muse Voice Transcribe turns the WAV into text, Muse Spark answers in the
// character's voice in one or two short sentences, and the player speaks / shows the reply.
// Separate from api/mcp.js on purpose: no MCP state, no card, nothing stored.
const API_BASE = 'https://api.meta.ai/v1';
const MODEL_API_KEY = process.env.MODEL_API_KEY || '';
const ASR_MODEL = 'muse-voice-transcribe-1.0';
const SPARK_MODEL = 'muse-spark-1.3';
const MAX_AUDIO = 2 * 1024 * 1024;   // ~60 s of 16 kHz mono WAV, far more than a poke needs

const ALLOWED = /^https:\/\/(hackar-s\.com|[a-z0-9-]+\.hackar-s\.com|hackar-[a-z0-9]+-kassyhackitcojps-projects\.vercel\.app)$/;
const cors = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED.test(origin || '') ? origin : 'https://hackar-s.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Vary': 'Origin',
});
const json = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) } });

async function transcribe(wav) {
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ model: ASR_MODEL, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' })], { type: 'application/json' }));
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'poke.wav');
  const res = await fetch(`${API_BASE}/asr/transcribe`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MODEL_API_KEY}`, accept: 'text/plain' },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`asr http ${res.status} ${(await res.text()).slice(0, 160)}`);
  // text/plain: one turn per line, "unknown:" / "A:" speaker prefixes in some modes
  return (await res.text()).split('\n').map((l) => l.replace(/^[A-Za-z]+:/, '').trim()).filter(Boolean).join(' ');
}

async function reply({ heard, name, persona, lang, history }) {
  const sys = `You are ${name || 'a small AR character'}, standing on the user's floor in augmented reality. ${persona || 'You are cheerful and a little mischievous.'} `
    + `The user just poked you with their finger and said something. Answer in ${lang === 'en' ? 'English' : 'Japanese (casual, friendly)'}, in one or two short sentences, in character. `
    + 'No emojis, no stage directions, no markdown.';
  const messages = [{ role: 'system', content: sys }];
  for (const h of (Array.isArray(history) ? history : []).slice(-6)) {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') messages.push({ role: h.role, content: h.content.slice(0, 300) });
  }
  messages.push({ role: 'user', content: heard || (lang === 'en' ? '(pokes you without saying anything)' : '（何も言わずにつついた）') });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
      // a reasoning model: keep the thinking short so a one-line answer isn't cut off
      body: JSON.stringify({ model: SPARK_MODEL, temperature: 0.9, max_tokens: 3000, reasoning_effort: attempt === 0 ? 'low' : undefined, messages }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 400 && attempt === 0) continue;   // reasoning_effort not accepted: retry without it
    if (!res.ok) throw new Error(`spark http ${res.status}`);
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || '').replace(/```/g, '').trim();
    if (text) return { text: text.slice(0, 240), usage: data?.usage || null };
  }
  throw new Error('spark returned empty content');
}

async function handle(request) {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405, origin);
  if (origin && !ALLOWED.test(origin)) return json({ error: 'origin not allowed' }, 403, origin);
  if (!MODEL_API_KEY) return json({ error: 'model api key is not configured' }, 503, origin);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'body must be a JSON object' }, 400, origin);
  if (typeof body.text !== 'string' && typeof body.audio !== 'string') return json({ error: 'text or audio is required' }, 400, origin);
  const t0 = Date.now();
  try {
    let heard = typeof body.text === 'string' ? body.text.slice(0, 300) : '';
    let asrMs = 0;
    if (!heard && typeof body.audio === 'string' && body.audio) {
      const wav = Buffer.from(body.audio, 'base64');
      if (wav.length > MAX_AUDIO) return json({ error: 'audio too long' }, 413, origin);
      const ta = Date.now();
      heard = await transcribe(wav);
      asrMs = Date.now() - ta;
    }
    const r = await reply({ heard, name: String(body.name || '').slice(0, 60), persona: String(body.persona || '').slice(0, 400), lang: body.lang === 'en' ? 'en' : 'ja', history: body.history });
    console.log('[TALK]', JSON.stringify({ at: new Date().toISOString(), asr: ASR_MODEL, asrMs, heardLen: heard.length, spark: SPARK_MODEL, usage: r.usage, ms: Date.now() - t0 }));
    return json({ heard, reply: r.text, models: { asr: body.audio ? ASR_MODEL : null, spark: SPARK_MODEL }, usage: r.usage }, 200, origin);
  } catch (e) {
    console.log('[TALK] error', JSON.stringify({ error: String(e?.message || e), ms: Date.now() - t0 }));
    return json({ error: 'talk failed', detail: String(e?.message || e).slice(0, 200) }, 502, origin);
  }
}

export const POST = handle;
export const OPTIONS = handle;
export const GET = handle;
