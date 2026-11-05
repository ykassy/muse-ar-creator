// MOSHI MOSHI — 「Talk to Muse, unlock AR」
// Muse の会話からコネクターがアクションし、Meta Model API で AR の中身を組み立てて、
// アプリレス WebAR として公開する MCP サーバー（Streamable HTTP・ステートレス）。
// 構造は 以前の自社コネクター試作と同じ流儀：単一ファイル＋署名付き「カード」メモで状態を持つ。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import VFX_SOURCES from './vfx-sources.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { z } from 'zod';
import { buildFittingGlb } from './glb.mjs';
import { normAns, answerForms } from './answers.mjs';
import { parseSamText, decodeOneBitMask } from './sam.mjs';

const BASE = process.env.PUBLIC_BASE_URL || 'https://hackathon-ar-creator.vercel.app';
const SECRET = process.env.CARD_SECRET || '';
// The default secret was public (it shipped in this file), so running without
// CARD_SECRET would let anyone forge cards. Refuse to start instead.
if (!SECRET) throw new Error('CARD_SECRET is not set: refusing to start.');
const MODEL_API_KEY = process.env.MODEL_API_KEY || '';
const HACKARS_API_KEY = process.env['HACKARS_API_KEY'] || '';
const HACKARS_API_URL = process.env.HACKARS_API_URL || 'https://hackar-s.com/api/project-create';
const ASSET_STORE_URL = process.env.ASSET_STORE_URL || 'https://hackar-s.com/api/asset-store';
const API_BASE = 'https://api.meta.ai/v1';
const SPARK_MODEL = 'muse-spark-1.3';
const IMAGE_MODEL = 'muse-image-1.0';
const SAM_MODEL = 'sam-3.1';

// Published effects are the five real Ultra Elements spells only (verified in
// the production player). Sprite particles (smoke/petal/bubble/...) are never
// attached to published works.
const ULTRA_SPELLS = [
  { id: 'lightning', spell: 'lightning', form: 'Thunderstrike', label: '雷' },
  { id: 'fire', spell: 'fire', form: 'Fireball', label: '炎' },
  { id: 'frozen-lightning', spell: 'frozen-lightning', form: '', label: '氷の稲妻' },
  { id: 'starfall', spell: 'starfall', form: '', label: '星の魔法陣' },
  { id: 'light', spell: 'light', form: 'Judgment', label: '光の柱' },
];
const spellOf = (id) => ULTRA_SPELLS.find((s) => s.id === id) || ULTRA_SPELLS[0];

// ---- 署名付きトークン（以前の自社試作と同じ仕組みを新規実装） ----
// カード：会話の状態（同意・テーマ・AR・証明）を指す短い札。Muse が持ち回る。
// AR／証明トークン：表示に必要な最小データを署名付きで URL 自体に埋め込む（ページは再起動後も開ける）。
const sign = (s) => createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 10);
const packTok = (obj) => { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${b}.${sign(b)}`; };
const readTok = (tok) => {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{10})$/.exec((tok || '').trim());
  if (!m || sign(m[1]) !== m[2]) return null;
  try { return JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { return null; }
};
// The card is a short signed pointer, because Muse has to write it back on every call: a card of
// several KB is slow to copy and one wrong character loses the session. The state itself is saved
// as write-once versions in the asset store, so any server instance can read it. An old card still
// works: reading walks forward to the newest version, so a reply lost on the way cannot bring back
// an older character. Long HC1 cards from earlier chats are still accepted.
const stateName = (o, q) => `${String(o).toUpperCase()}-${String(q).padStart(4, '0')}`;
const stateUrl = (o, q) => `${PLAY_JSON_BASE}code/${stateName(o, q)}.json?v=${Date.now()}`;
const stateOf = (u) => ({ n: u.nickname, o: u.ownerId || null, a: u.agreed ? 1 : 0, t: u.theme || null, ar: u.arTok || null, c: u.certTok || null, us: u.usage || null, hu: u.hackarsUrl || null, hp: u.hackarsProjectId || null, ct: u.composedAt || 0, cq: u.composedSeq || 0, w: u.working || 0, h: u.held || null });
const longCard = (u) => `HC1.${packTok(stateOf(u))}`;
const applyState = (u, c) => {
  Object.assign(u, { agreed: !!c.a, theme: c.t, arTok: c.ar, arId: readTok(c.ar)?.i || null, certTok: c.c, usage: c.us, hackarsUrl: c.hu, hackarsProjectId: c.hp || null, composedAt: c.ct || 0, composedSeq: c.cq || 0, working: c.w || 0, held: c.h || null, seq: c.q });
  u.savedJson = JSON.stringify(stateOf(u));
};
async function saveVersion(o, q, json) {
  try {
    const r = await fetch(ASSET_STORE_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': HACKARS_API_KEY }, body: JSON.stringify({ kind: 'json', base64: Buffer.from(json).toString('base64'), name: stateName(o, q) }), signal: AbortSignal.timeout(15_000) });
    if (r.ok) return 'saved';
    return r.status === 409 ? 'taken' : 'failed';
  } catch { return 'failed'; }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Versions are write-once, so writing the next one is atomic. "taken" means another instance got
// there first; a failed write tries the same version again, because a gap would hide what follows.
async function saveState(u) {
  for (let k = 0; k < 6; k++) {
    const next = (u.seq || 0) + 1, json = JSON.stringify(stateOf(u));
    const r = await saveVersion(u.ownerId, next, json);
    if (r === 'saved') { u.seq = next; u.savedJson = json; return true; }
    if (r === 'failed') { await pause(250 * (k + 1)); continue; }
    let c;
    try { c = await newestState(u.ownerId, next); } catch { await pause(250 * (k + 1)); continue; }
    if (!c || c.keep) { u.seq = next; continue; }
    if ((c.ct || 0) > (u.composedAt || 0)) { applyState(u, c); return true; }   // it holds a newer character: ours is out of date
    if (!u.holding) u.working = c.w || 0;
    u.seq = c.q;
  }
  return false;
}
async function packCard(u) {
  if (!u.ownerId) return longCard(u);
  if (JSON.stringify(stateOf(u)) !== u.savedJson && !(await saveState(u))) return longCard(u);   // storage is down: the long card still carries everything
  const b = `${u.ownerId}.${u.seq}`;
  return `HC3.${b}.${sign(b)}`;
}
// One long job per session. The first instance to write the "working" version holds it. Losing the
// race can bring in a newer state, so the caller checks again after a claim. With storage down
// nobody can hold the job, so it does not start.
async function claimWork(u) {
  for (let k = 0; k < 6; k++) {
    const next = (u.seq || 0) + 1;
    u.working = Date.now();
    const json = JSON.stringify(stateOf(u));
    const r = await saveVersion(u.ownerId, next, json);
    if (r === 'saved') { u.seq = next; u.savedJson = json; u.holding = true; return 'claimed'; }
    if (r === 'failed') { await pause(250 * (k + 1)); continue; }
    let c;
    try { c = await newestState(u.ownerId, next); } catch { await pause(250 * (k + 1)); continue; }
    if (c && !c.keep) applyState(u, c); else { u.seq = next; u.working = 0; }
    if (stillWorking(u)) return 'busy';
  }
  u.working = 0;
  return 'down';
}
const releaseWork = (u) => { u.working = 0; u.holding = false; };
// A version that does not exist is null. A read that fails throws, because "could not read" must
// never pass for "nothing newer": that would bring back an older character.
async function readVersion(url) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (r.status === 400 || r.status === 404) return null;   // the bucket answers 400 for a missing object
      if (r.ok) return await r.json();
      throw new Error(`state read http ${r.status}`);
    } catch (e) {
      if (k >= 2) throw e;
      await pause(300 * (k + 1));
    }
  }
}
async function newestState(o, from) {
  const mem = users.get(o);
  let q = Math.max(from, mem?.seq || 0);
  let state = mem?.seq === q ? null : await readVersion(stateUrl(o, q));
  for (;;) {   // looks a little past a gap, in case a version was never written
    const ahead = await Promise.all([1, 2, 3].map((d) => readVersion(stateUrl(o, q + d))));
    const k = ahead.findLastIndex(Boolean);
    if (k < 0) break;
    state = ahead[k]; q += k + 1;
  }
  if (state) return { ...state, q };
  return mem ? { o, keep: true } : null;
}
async function readCard(card) {
  const raw = (card || '').trim();
  const m = /^HC3\.([a-z0-9]{4,14})\.(\d{1,4})\.([A-Za-z0-9_-]{10})$/.exec(raw);
  if (m) return sign(`${m[1]}.${m[2]}`) === m[3] ? newestState(m[1], +m[2]) : null;
  const old = /^HC1\.([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10})$/.exec(raw);
  return old ? readTok(old[1]) : null;
}

// ---- 状態：サーバーメモリ＋カードの2本立て（メモリが消えたらカードを正にする） ----
const users = new Map(); // ownerId -> session (a nickname alone never resumes a session)
const imgs = new Map();  // imgId -> { buf: Buffer, type } | { remote: url }  (cache; durable copies live in asset-store)
const keyOf = (nickname) => (nickname || 'guest').trim().toLowerCase() || 'guest';
const mintOwnerId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const freshUser = (nickname) => ({ nickname: keyOf(nickname), ownerId: null, agreed: false, theme: null, arTok: null, arId: null, certTok: null, usage: null, hackarsUrl: null, hackarsProjectId: null });
const getU = async (nickname, card) => {
  let c;
  try { c = await readCard(card); }
  catch (e) {
    console.log('[AR] state-read-failed', JSON.stringify({ error: String(e?.message || e) }));
    return { ...freshUser(nickname), badCard: true, readFailed: true };
  }
  if (c?.o) {
    // A card identifies its owner's session, independent of the nickname.
    if (!users.has(c.o)) users.set(c.o, { ...freshUser(c.n || nickname), ownerId: c.o });
    const u = users.get(c.o);
    if (c.keep) return u;
    if (c.q) { applyState(u, c); return u; }   // the saved state is the truth, whatever this instance remembers
    if (c.a) u.agreed = true;
    if (c.t && !u.theme) u.theme = c.t;
    if (c.ar && !u.arTok) { u.arTok = c.ar; const p = readTok(c.ar); if (p) u.arId = p.i; }
    if (u.arTok === c.ar) u.held = c.h || null;
    if (c.c && !u.certTok) u.certTok = c.c;
    if (c.us && !u.usage) u.usage = c.us;
    // The link belongs to the character it was published for. An older card must
    // not hand a newer character the previous link.
    if (c.hu && !u.hackarsUrl && u.arTok === c.ar) u.hackarsUrl = c.hu;
    return u;
  }
  // No card: never inherit another person's consent, theme or AR by nickname.
  return { ...freshUser(nickname || c?.n), badCard: !!(card && !c) };
};
// Durable asset storage (HACKAR:S deployments bucket via /api/asset-store).
async function storeAsset(kind, buf, name) {
  if (!HACKARS_API_KEY || !buf) return null;
  try {
    const r = await fetch(ASSET_STORE_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': HACKARS_API_KEY }, body: JSON.stringify({ kind, base64: buf.toString('base64'), ...(name ? { name } : {}) }), signal: AbortSignal.timeout(30_000) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.url ? j.url : null;
  } catch { return null; }
}
// In run 41 Muse's client reported that the event stream ended before the result, and Muse called
// compose_ar again, which drew a second character. The saved versions can tell: a card older than
// the version that holds the character means the caller never got that reply. So a repeat with the
// same theme, soon after, gets the same character back instead of a new drawing.
const seqOfCard = (card) => { const m = /^HC3\.[a-z0-9]{4,14}\.(\d{1,4})\./.exec((card || '').trim()); return m ? +m[1] : null; };
const missedReply = (u, card, theme) => {
  const seen = seqOfCard(card);
  if (seen === null || !u.arTok || u.hackarsUrl || !(u.composedSeq > seen) || Date.now() - (u.composedAt || 0) > 300_000) return false;
  return readTok(u.arTok)?.th === (theme ? String(theme).slice(0, 160) : u.theme);
};
const missedComposeReply = async (u) => {
  const p = readTok(u.arTok) || {};
  const spell = spellOf(p.e);
  const hold = u.held ? `${u.held.r ? `\n${u.held.r === '?' ? 'Muse Spark could not say whether this uses someone else\'s IP.' : `This uses ${u.held.r}, which may belong to someone else.`}` : ''}${u.held.s !== null && u.held.s !== undefined ? `\nMuse Spark scored this drawing ${u.held.s}/10.` : ''}\nDo not publish yet: ask the user first. publish_ar refuses it until they agree (confirmed: true).` : '\nPublish it? (You get a hackar-s.com link.)';
  const holdJa = u.held ? `${u.held.r ? `\n${u.held.r === '?' ? 'Muse Spark は、他の人の IP を使っているかどうかを確かめられなかったよ。' : `これは${u.held.r}を使っていて、他の人のものかもしれないよ。`}` : ''}${u.held.s !== null && u.held.s !== undefined ? `\nMuse Spark の判定は ${u.held.s}/10 だったよ。` : ''}\nまだ公開しないで、ユーザーに聞いてね。そう言われるまで publish_ar は公開を断るよ（confirmed: true）。` : '\nこのまま公開する？（公開すると hackar-s.com のURLが発行されるよ）';
  const text = p.lg === 'en'
    ? `This character was already finished, so nothing new was drawn (the last reply did not reach you). "${p.ti}"\n${p.tx}\nName: ${p.nm} / Personality: ${p.ps}\nSpell: ${spell.id}${hold}`
    : `このキャラはもうできていたので、新しくは描かなかったよ（前の返事が届かなかったみたい）。「${p.ti}」\n${p.tx}\nキャラ名：${p.nm}／性格：${p.ps}\n魔法：${spell.label}${holdJa}`;
  console.log('[AR] compose-resumed', JSON.stringify({ nickname: u.nickname, arId: u.arId }));
  return { content: [{ type: 'text', text }], structuredContent: { resumed: true, preview: p.f?.neutral || null, glb: p.g || null, lang: p.lg, title: p.ti, text: p.tx, color: p.c, effect: p.e, characterName: p.nm, persona: p.ps, theme: p.th, usedModel: true, hasGlb: !!p.g, card: await packCard(u) } };
};
const cardArg = z.string().max(20000).optional().describe('前のツールの structuredContent にある card（HC3. で始まる短い文字列）。1文字も変えずにそのまま入れる');
// A compose can outlast a dropped call. These replies say what is still running, so Muse waits
// instead of starting the same character again.
const stillWorking = (u) => u.working && Date.now() - u.working < 170_000;
const busyReply = async (u, tool) => ({
  content: [{ type: 'text', text: `This character is still being made on the server. Wait about 30 seconds, then call ${tool} again with the same card. Do not start over. / まだサーバーで作っている途中だよ。30秒ほど待って、同じ card でもう一度 ${tool} を呼んでね。最初からやり直さないで。` }],
  structuredContent: { composing: true, card: await packCard(u) },
});
// A drawing Spark did not pass, or one that uses someone else's IP, is not published until the user
// has heard why and agreed. The mark lives in the saved state with that character, so a new drawing
// clears it and an old card cannot.
const heldReply = async (u) => {
  const { s, i, r } = u.held;
  const why = (i || []).join(', ');
  const failed = s !== null && s !== undefined;
  const text = readTok(u.arTok)?.lg === 'en'
    ? `Not published. ${r === '?' ? 'Muse Spark could not say whether this uses someone else\'s IP. ' : r ? `This uses ${r}, which may belong to someone else. ` : ''}${failed ? `Muse Spark scored this drawing ${s}/10${why ? ` (${why})` : ''}. ` : ''}Tell the user, then ask: ${r ? 'do you own it or have permission to use it?' : 'publish it anyway, or make a new one?'} Call publish_ar with confirmed: true only if the user says to go ahead.`
    : `まだ公開していません。${r === '?' ? 'Muse Spark は、他の人の IP を使っているかどうかを確かめられませんでした。' : r ? `これは${r}を使っていて、他の人のものかもしれません。` : ''}${failed ? `Muse Spark の判定は ${s}/10${why ? `（${why}）` : ''} でした。` : ''}ユーザーに伝えて、${r ? '権利を持っているか、許可を得ているか' : '「このまま公開する／作り直す」'}を聞いてください。「公開する」と言われたときだけ confirmed: true で publish_ar を呼びます。`;
  return { content: [{ type: 'text', text }], structuredContent: { needsConfirmation: true, ...(failed ? { selfCheck: { score: s, issues: i || [] } } : {}), ...(r ? { rights: r === '?' ? 'unknown' : r } : {}), card: await packCard(u) } };
};
const retryReply = () => ({
  content: [{ type: 'text', text: 'The saved session could not be reached just now, so nothing was changed. Try the same call again in a moment with the same card. / 保存した状態にいま届きませんでした。何も変えていません。少し待って、同じ札でもう一度呼んでください。' }],
  structuredContent: { retryLater: true },
});
const badCardReply = (u) => u?.readFailed ? retryReply() : ({
  content: [{ type: 'text', text: 'That card could not be read. Copy the card from the last reply exactly and call again. Nothing was lost, so do not compose again. / card が読めなかったよ。直前の返事の card を1文字も変えずに入れて、もう一度呼んでね。作ったものは消えていないので、作り直さないで。' }],
  structuredContent: { badCard: true },
});
const nickArg = z.string().max(40).optional().describe('ユーザーの呼び名（毎回同じものを入れる）');

// ---- Meta Model API ----
// 会話の言語：テーマに日本語が含まれれば 'ja'、そうでなければ 'en'。
// キャラの名前・性格・会話言語（HACKAR:S の talkLang）はこれに合わせる。
const langOf = (theme) => /[぀-ヿ一-鿿]/.test(String(theme || '')) ? 'ja' : 'en';
async function fetchSpark(theme) {
  const lang = langOf(theme);
  const nameLine = lang === 'en'
    ? '- "name": the character\'s own name in English, at most 16 characters'
    : '- "name": the character\'s own name in Japanese, at most 10 characters';
  const personaLine = lang === 'en'
    ? '- "persona": the character\'s personality in English, 1-2 short sentences (it speaks in this voice when poked)'
    : '- "persona": the character\'s personality in Japanese, 1-2 short sentences (it speaks in this voice when poked)';
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      model: SPARK_MODEL,
      temperature: 0.8,
      reasoning_effort: 'low',
      // muse-spark-1.3 は推論モデル：推論トークンで本文が食い尽くされないよう上限を広く取る
      max_tokens: 2500,
      messages: [
        { role: 'system', content: 'You are an AR experience composer for an app-less WebAR product. Reply with ONE JSON object only, no markdown, no code fences, no commentary.' },
        { role: 'user', content: `Compose a small AR character for the theme: "${theme}".\nReturn JSON with exactly these keys:\n- "title": a short ${lang === 'en' ? 'English title, at most 5 words' : 'Japanese title, at most 14 characters'}\n- "text": one ${lang === 'en' ? 'English line shown over the camera view, at most 90 characters' : 'Japanese line shown over the camera view, at most 40 characters'}\n- "color": one base color as #RRGGBB that matches the mood\n- "effect": one of "lightning", "fire", "frozen-lightning", "starfall", "light" — the magic spell this character casts; pick the one that best matches the theme\n${nameLine}\n${personaLine}\n- "ip": if the theme names a character, brand or franchise that belongs to someone else (for example Pikachu, Hello Kitty, Kumamon, Nike), its name; otherwise an empty string\n- \"action\": one short English sentence describing how the character moves in a seamless in-place loop` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`spark http ${res.status}`);
  const data = await res.json();
  return { raw: data?.choices?.[0]?.message?.content || '', usage: data?.usage || null };
}

// content が null/空（推論で食い尽くされた等）や JSON が読めない場合は1回だけ再試行し、
// それでもダメなら例外にして呼び出し側のテンプレートフォールバックに委ねる。
async function callSpark(theme) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { raw, usage } = await fetchSpark(theme);
    const cleaned = String(raw).replace(/```(?:json)?/gi, '');
    const m = /\{[\s\S]*\}/.exec(cleaned);
    if (m) {
      try { return { comp: normalizeComp(JSON.parse(m[0]), theme), usage }; }
      catch (e) { lastErr = e; }
    } else {
      lastErr = new Error('spark returned empty/unparseable content');
    }
    console.log('[AR] spark-retry', JSON.stringify({ theme, attempt: attempt + 1, reason: String(lastErr?.message || lastErr) }));
  }
  throw lastErr || new Error('spark failed');
}

// クロマキーのキー色：被写体が緑系のテーマだけ青、それ以外は緑（被写体と背景を分けるため）
const keyFor = (theme) => /(葉|緑|グリーン|カエル|森|草|抹茶|苔|leaf|green|frog|forest|moss)/i.test(String(theme || ''))
  ? { name: 'blue', hex: '#0000FF', ch: 2 }
  : { name: 'green', hex: '#00FF00', ch: 1 };

async function callImage(theme, comp, background, fix = '') {
  const key = keyFor(theme);
  const basePrompt = `A single charming mascot-like character illustration for an AR overlay, theme: "${theme}"${comp?.title ? ` (${comp.title})` : ''}. Flat vector style, bold shapes, bold dark outline, no text, no letters, centered, full body, playful.${fix ? ` ${fix}` : ''}`;
  const prompt = background === 'transparent'
    ? `${basePrompt} The character stands on a completely solid vivid ${key.name} (${key.hex}) chroma key background that fills the entire frame edge to edge. Anything the theme names that the character holds or wears is drawn complete and inside the frame. No shadow, no gradient, no floor, no ground line, no scenery, no floating decorations.`
    : `${basePrompt} Clean solid background in the base color ${comp.color}.`;
  const mkBody = (png) => JSON.stringify({
    model: IMAGE_MODEL, prompt, size: '1024x1024',
    ...(png ? { output_format: 'png' } : {}),
  });
  const attempt = async (png) => {
    const res = await fetch(`${API_BASE}/images/generations`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(40_000),
      body: mkBody(png),
    });
    if (!res.ok) throw new Error(`image http ${res.status}`);
    const data = await res.json();
    const d = data?.data?.[0] || {};
    // 返却は URL ではなく data[0].b64_json。バイト列は呼び出し側で /img/<id> 配信に回す。
    if (d.b64_json) return { b64: d.b64_json, remote: null, usage: data?.usage || null, type: png ? 'image/png' : 'image/webp', keyCh: key.ch };
    if (d.url) return { b64: null, remote: d.url, usage: data?.usage || null, type: 'image/webp', keyCh: key.ch };
    throw new Error('image returned no data');
  };
  if (background === 'transparent') {
    try { return await attempt(true); } // PNG で受けてサーバー側で色抜きする
    catch (e) { console.log('[AR] image-png-failed', JSON.stringify({ error: String(e?.message || e) })); return await attempt(false); }
  }
  return attempt(false);
}

// ---- PNG コーデック＋クロマキー（純JS・依存なし。8bit / color type 2,6 / 非インタレース） ----
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idats.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error('unsupported png format');
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idats));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  let p = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, rgba: out };
}
const PNG_CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff;
  for (let i = 0; i < td.length; i++) c = PNG_CRC_TABLE[(c ^ td[i]) & 255] ^ (c >>> 8);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
// キー色の「勝ち具合」でアルファを作り、最大の連結成分（本体）だけ残し、フチの色かぶりを抑える
function keyOut(rgba, w, h, keyChannel) {
  const n = w * h;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const key = keyChannel === 1 ? g : b;
    const other = keyChannel === 1 ? Math.max(r, b) : Math.max(r, g);
    let a = (110 - (key - other)) / 110; if (a < 0) a = 0; else if (a > 1) a = 1;
    alpha[i] = a * 255;
  }
  const sw = Math.max(1, Math.floor(w / 4)), sh = Math.max(1, Math.floor(h / 4));
  const sm = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sm[y * sw + x] = alpha[(y * 4) * w + x * 4] > 110 ? 1 : 0;
  const lab = new Int32Array(sw * sh).fill(-1);
  let best = -1, bestSize = 0, cur = 0;
  const stack = [];
  for (let s = 0; s < sw * sh; s++) {
    if (!sm[s] || lab[s] >= 0) continue;
    let size = 0; stack.length = 0; stack.push(s); lab[s] = cur;
    while (stack.length) {
      const q = stack.pop(); size++;
      const qx = q % sw, qy = (q / sw) | 0;
      if (qx > 0 && sm[q - 1] && lab[q - 1] < 0) { lab[q - 1] = cur; stack.push(q - 1); }
      if (qx < sw - 1 && sm[q + 1] && lab[q + 1] < 0) { lab[q + 1] = cur; stack.push(q + 1); }
      if (qy > 0 && sm[q - sw] && lab[q - sw] < 0) { lab[q - sw] = cur; stack.push(q - sw); }
      if (qy < sh - 1 && sm[q + sw] && lab[q + sw] < 0) { lab[q + sw] = cur; stack.push(q + sw); }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
    cur++;
  }
  if (best >= 0 && cur > 1) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (lab[((y / 4) | 0) * sw + ((x / 4) | 0)] !== best) alpha[y * w + x] = 0;
    }
  }
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    if (a < 255) {
      if (keyChannel === 1) { const mx = Math.max(rgba[i * 4], rgba[i * 4 + 2]); if (rgba[i * 4 + 1] > mx + 12) rgba[i * 4 + 1] = mx + 12; }
      else { const mx = Math.max(rgba[i * 4], rgba[i * 4 + 1]); if (rgba[i * 4 + 2] > mx + 12) rgba[i * 4 + 2] = mx + 12; }
    }
    rgba[i * 4 + 3] = a;
  }
}
function makeTransparent(buf, keyChannel) {
  const { w, h, rgba } = decodePng(buf);
  keyOut(rgba, w, h, keyChannel);
  return encodePng(w, h, rgba);
}

// Spark が返した構成を安全な値に寄せる
// ---- animated GIF synthesis: bake looping character motion from the still cutout ----
// The HACKAR:S player loops GIF overlays natively (isGif), so a baked GIF is
// what makes the character keep moving there. Frames are transforms of the
// one generated still: hop / bounce / float / sway, bottom-center pivot.
function scaleRgba(img, tw, th) {
  const { w, h, rgba: data } = img;
  const out = new Uint8Array(tw * th * 4);
  const xr = w / tw, yr = h / th;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const gx = (x + 0.5) * xr - 0.5, gy = (y + 0.5) * yr - 0.5;
      const x0 = Math.max(0, Math.floor(gx)), y0 = Math.max(0, Math.floor(gy));
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, gx - x0)), fy = Math.min(1, Math.max(0, gy - y0));
      for (let c = 0; c < 4; c++) {
        const top = data[(y0 * w + x0) * 4 + c] * (1 - fx) + data[(y0 * w + x1) * 4 + c] * fx;
        const bot = data[(y1 * w + x0) * 4 + c] * (1 - fx) + data[(y1 * w + x1) * 4 + c] * fx;
        out[(y * tw + x) * 4 + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return { w: tw, h: th, rgba: out };
}
function xformFrame(img, o) {
  const { w, h, rgba: data } = img;
  const out = new Uint8Array(w * h * 4);
  const px = w / 2, py = h;
  const cos = Math.cos(o.rot || 0), sin = Math.sin(o.rot || 0);
  const sx = o.sx || 1, sy = o.sy || 1, dy = o.dy || 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - px, dyy = (y - dy) - py;
      const rx = dx * cos + dyy * sin, ry = -dx * sin + dyy * cos;
      const srcX = Math.round(px + rx / sx), srcY = Math.round(py + ry / sy);
      if (srcX < 0 || srcY < 0 || srcX >= w || srcY >= h) continue;
      const si = (srcY * w + srcX) * 4, di = (y * w + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return { w, h, rgba: out };
}
function buildPalette(img, maxColors = 255) {
  const d = img.rgba;
  const pixels = [];
  for (let i = 0; i < d.length; i += 32) {
    if (d[i + 3] >= 128) pixels.push([d[i], d[i + 1], d[i + 2]]);
  }
  if (!pixels.length) return [[255, 0, 255]];
  let boxes = [pixels];
  while (boxes.length < maxColors) {
    let bi = -1, bc = 0, bestScore = -1;
    boxes.forEach((box, idx) => {
      if (box.length < 2) return;
      const min = [255, 255, 255], max = [0, 0, 0];
      for (const p of box) for (let c = 0; c < 3; c++) { if (p[c] < min[c]) min[c] = p[c]; if (p[c] > max[c]) max[c] = p[c]; }
      let ch = 0, range = -1;
      for (let c = 0; c < 3; c++) { const r = max[c] - min[c]; if (r > range) { range = r; ch = c; } }
      const score = range * box.length;
      if (score > bestScore) { bestScore = score; bi = idx; bc = ch; }
    });
    if (bi < 0) break;
    const box = boxes.splice(bi, 1)[0];
    box.sort((a, b) => a[bc] - b[bc]);
    const mid = box.length >> 1;
    boxes.push(box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => {
    const s = [0, 0, 0];
    for (const p of box) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
    const n = Math.max(1, box.length);
    return [Math.round(s[0] / n), Math.round(s[1] / n), Math.round(s[2] / n)];
  });
}
function mapToPalette(img, palette) {
  const idx = new Uint8Array(img.w * img.h);
  const cache = new Map();
  const d = img.rgba;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    if (d[i + 3] < 128) { idx[p] = 0; continue; }
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let v = cache.get(key);
    if (v === undefined) {
      let best = 1, bd = Infinity;
      for (let j = 1; j < palette.length; j++) {
        const dr = d[i] - palette[j][0], dg = d[i + 1] - palette[j][1], db = d[i + 2] - palette[j][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bd) { bd = dist; best = j; }
      }
      v = best; cache.set(key, v);
    }
    idx[p] = v;
  }
  return idx;
}
function gifLzw(indices, minCodeSize) {
  const bytes = [];
  let acc = 0, accBits = 0;
  const clearCode = 1 << minCodeSize, eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map(), nextCode = eoiCode + 1;
  function emit(code) {
    acc |= code << accBits; accBits += codeSize;
    while (accBits >= 8) { bytes.push(acc & 0xff); acc >>= 8; accBits -= 8; }
  }
  function resetDict() { dict = new Map(); nextCode = eoiCode + 1; codeSize = minCodeSize + 1; }
  emit(clearCode);
  let prevCode = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prevCode * 256 + k;
    const existing = dict.get(key);
    if (existing !== undefined) { prevCode = existing; continue; }
    emit(prevCode);
    dict.set(key, nextCode++);
    if (nextCode - 1 === (1 << codeSize) && codeSize < 12) codeSize++;
    if (nextCode > 4095) { emit(clearCode); resetDict(); }
    prevCode = k;
  }
  emit(prevCode);
  emit(eoiCode);
  if (accBits > 0) bytes.push(acc & 0xff);
  return Buffer.from(bytes);
}
function motionFrameOpts(motion, i, n) {
  const t = i / n, TAU = Math.PI * 2;
  if (motion === 'hop') {
    const s = Math.sin(Math.PI * t), contact = 1 - s;
    return { dy: -Math.round(36 * s), sy: 1 - 0.12 * contact + 0.04 * s, sx: 1 + 0.09 * contact - 0.02 * s, rot: 0 };
  }
  if (motion === 'bounce') {
    const tt = (t * 2) % 1, s = Math.sin(Math.PI * tt), contact = 1 - s;
    return { dy: -Math.round(22 * s), sy: 1 - 0.16 * contact + 0.03 * s, sx: 1 + 0.11 * contact - 0.02 * s, rot: 0 };
  }
  if (motion === 'float') {
    return { dy: -Math.round(12 + 9 * Math.sin(TAU * t)), sy: 1 + 0.02 * Math.sin(TAU * t), sx: 1, rot: 0.03 * Math.sin(TAU * t) };
  }
  if (motion === 'sway') {
    return { dy: -4, sy: 1, sx: 1, rot: 0.10 * Math.sin(TAU * t) };
  }
  return { dy: 0, sy: 1, sx: 1, rot: 0 };
}
function makeAnimGif(pngBuf, motion) {
  const src = decodePng(pngBuf);
  const maxDim = 640;
  const scale = Math.min(1, (maxDim * 0.86) / Math.max(src.w, src.h));
  const inner = scale < 1 ? scaleRgba(src, Math.round(src.w * scale), Math.round(src.h * scale)) : src;
  // pad onto a square canvas (headroom so hops/rotations never clip the frame)
  const S = Math.round(Math.max(inner.w, inner.h) / 0.86);
  const canvas = new Uint8Array(S * S * 4);
  const ox = Math.round((S - inner.w) / 2), oy = S - inner.h;
  for (let y = 0; y < inner.h; y++) {
    canvas.set(inner.rgba.subarray(y * inner.w * 4, (y + 1) * inner.w * 4), ((y + oy) * S + ox) * 4);
  }
  const img = { w: S, h: S, rgba: canvas };
  const colors = buildPalette(img);
  const palette = [[0, 0, 0], ...colors].slice(0, 256);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const N = 12, delay = motion === 'bounce' ? 8 : 9;
  const parts = [];
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'ascii');
  head.writeUInt16LE(img.w, 6); head.writeUInt16LE(img.h, 8);
  head[10] = 0xf7; head[11] = 0; head[12] = 0;
  parts.push(head);
  const gct = Buffer.alloc(256 * 3);
  palette.forEach((c, i) => { gct[i * 3] = c[0]; gct[i * 3 + 1] = c[1]; gct[i * 3 + 2] = c[2]; });
  parts.push(gct);
  parts.push(Buffer.from([0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00]));
  for (let i = 0; i < N; i++) {
    const frame = xformFrame(img, motionFrameOpts(motion, i, N));
    const idx = mapToPalette(frame, palette);
    const lzw = gifLzw(idx, 8);
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x09, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00]);
    const idesc = Buffer.alloc(10);
    idesc[0] = 0x2c;
    idesc.writeUInt16LE(img.w, 5); idesc.writeUInt16LE(img.h, 7);
    parts.push(gce, idesc, Buffer.from([8]));
    for (let off = 0; off < lzw.length; off += 255) {
      const chunk = lzw.subarray(off, Math.min(lzw.length, off + 255));
      parts.push(Buffer.from([chunk.length]), chunk);
    }
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function normalizeComp(c, theme) {
  const color = /^#[0-9a-fA-F]{6}$/.test(c?.color || '') ? c.color : fallbackComp(theme).color;
  let effect = ULTRA_SPELLS.some((s) => s.id === c?.effect) ? c.effect : null;
  if (!effect) { // 言い換え・表記ゆれを吸収する（frozen を lightning より先に判定）
    const s = String(c?.effect || '').toLowerCase();
    effect = s.includes('frozen') || s.includes('氷') ? 'frozen-lightning'
      : s.includes('star') || s.includes('星') ? 'starfall'
      : s.includes('judg') || s.includes('柱') || s === 'light' ? 'light'
      : s.includes('fire') || s.includes('flame') || s.includes('炎') ? 'fire'
      : s.includes('lightning') || s.includes('thunder') || s.includes('雷') || s.includes('ice') || s.includes('snow') || s.includes('雪') ? 'lightning'
      : fallbackComp(theme).effect;
  }
  const fb = fallbackComp(theme);
  return {
    title: String(c?.title || '').slice(0, 60) || fb.title,
    text: String(c?.text || '').slice(0, 120) || fb.text,
    color, effect,
    name: String(c?.name || '').slice(0, 20) || fb.name,
    persona: String(c?.persona || '').slice(0, 200) || fb.persona,
    action: String(c?.action || '').slice(0, 120),
    // Only an explicit answer counts as "no third-party IP": a missing field means nobody checked.
    ip: typeof c?.ip !== 'string' || /^(null|undefined|n\/?a|unknown|不明)$/i.test(c.ip.trim()) ? '?' : /^(none|no|なし|無し|ない)?$/i.test(c.ip.trim()) ? '' : c.ip.trim().slice(0, 60),
  };
}

// 生成に失敗しても AR は必ず立てるためのテンプレート構成（テーマのハッシュで決定的に選ぶ）
const PALETTES = [
  { color: '#FF7A1A', effect: 'fire' },
  { color: '#39B5FF', effect: 'frozen-lightning' },
  { color: '#7A5CFF', effect: 'lightning' },
  { color: '#FFD75E', effect: 'starfall' },
];
function fallbackComp(theme) {
  const t = String(theme || '');
  const kw = [/(炎|火|燃|ドラゴン|fire|flame|dragon)/i, /(雪|氷|冬|snow|ice|winter)/i, /(雷|電|lightning|thunder|spark)/i, /(星|魔法|star|magic)/i];
  const ki = kw.findIndex((re) => re.test(t));
  let h = 0; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const p = PALETTES[ki >= 0 ? ki : h % PALETTES.length];
  return { title: `${theme} AR`, text: `Welcome to the world of ${theme}.`, color: p.color, effect: p.effect,
           name: String(theme || 'なかま').slice(0, 10), persona: `${theme}から生まれた小さななかま。好奇心いっぱいで、人と話すのが大好き。`,
           action: 'hops happily in place with squash and stretch', ip: '?' };
}

// chat（prompt/completion_tokens）と image（input/output_tokens）で形が違う usage を共通形に寄せる
const normUsage = (u) => {
  if (!u) return null;
  const inp = u.prompt_tokens ?? u.input_tokens ?? null;
  const out = u.completion_tokens ?? u.output_tokens ?? null;
  const total = u.total_tokens ?? (((inp ?? 0) + (out ?? 0)) || null);
  return { in: inp, out, total };
};
const usageTextEn = (label, usage) => {
  const n = normUsage(usage);
  return n ? `${label}: ${n.total ?? '?'} tokens (in ${n.in ?? '?'} / out ${n.out ?? '?'})` : `${label}: no token count`;
};
const usageText = (label, usage) => {
  const n = normUsage(usage);
  return n
    ? `${label}: ${n.total ?? '?'} トークン（入力 ${n.in ?? '?'} / 出力 ${n.out ?? '?'}）`
    : `${label}: トークン数なし`;
};

// ---- HTML ページ ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const jsJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

function arPage(tok) {
  const p = readTok(tok);
  if (!p) return new Response(pageShell('リンクが無効です', '<p>この AR のリンクは確認できませんでした。Muse で作り直してね。</p>'), { status: 404, headers: htmlHeaders() });
  const cfg = { title: p.ti, text: p.tx, color: p.c, effect: p.e, theme: p.th, image: p.im ? `/img/${p.im}` : null, bg: p.bg || 'card', mo: p.mo || 'bounce' };
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(p.ti)} — MOSHI MOSHI</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0b0b10;font-family:-apple-system,'Hiragino Sans',sans-serif;color:#fff}
#cam{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;background:linear-gradient(160deg,${esc(p.c)},#14141d 75%)}
#fx{position:fixed;inset:0;touch-action:none}
.hud{position:fixed;left:0;right:0;text-align:center;pointer-events:none;padding:0 18px;box-sizing:border-box}
#ttl{top:calc(18px + env(safe-area-inset-top));font-size:30px;font-weight:900;letter-spacing:.02em;text-shadow:0 2px 18px rgba(0,0,0,.55)}
#sub{top:calc(64px + env(safe-area-inset-top));font-size:14px;opacity:.92;text-shadow:0 1px 10px rgba(0,0,0,.6)}
#theme{bottom:calc(20px + env(safe-area-inset-bottom));font-size:13px;opacity:.85;text-shadow:0 1px 8px rgba(0,0,0,.6)}
#hint{position:fixed;left:50%;bottom:calc(52px + env(safe-area-inset-bottom));transform:translateX(-50%);font-size:13px;font-weight:700;background:rgba(0,0,0,.5);padding:8px 16px;border-radius:999px;white-space:nowrap;display:none}
#note{position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom));transform:translateX(-50%);font-size:12px;background:rgba(0,0,0,.45);padding:6px 12px;border-radius:999px;display:none;white-space:nowrap}
#start{position:fixed;inset:0;display:grid;place-items:center;background:rgba(8,8,14,.55);backdrop-filter:blur(3px);z-index:5}
#start button{border:0;border-radius:999px;padding:16px 34px;font-size:17px;font-weight:800;background:${esc(p.c)};color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.45)}
#fallback{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(62vw,260px);border-radius:20px;overflow:hidden;display:none;box-shadow:0 14px 44px rgba(0,0,0,.5)}
#fallback img{display:block;width:100%;height:auto}
</style></head><body>
<video id="cam" autoplay playsinline muted></video>
<canvas id="fx"></canvas>
<div class="hud" id="ttl">${esc(p.ti)}</div>
<div class="hud" id="sub">${esc(p.tx)}</div>
<div class="hud" id="theme">theme: ${esc(p.th)} ・ Talk to Muse, unlock AR</div>
<div id="hint">真ん中の輪を床に合わせて、タップで置く</div>
<div id="note"></div>
${cfg.image ? `<div id="fallback"><img src="${esc(cfg.image)}" alt=""></div>` : ''}
<div id="start"><button id="go">カメラで見る</button></div>
<script src="https://unpkg.com/three@0.152.2/build/three.min.js"></script>
<script>
var CFG = ${jsJson(cfg)};
var SPIN = /[?&]spin=1/.test(location.search);
// ---- 3Dパーティクル（Ultra Elements の考え方：1エフェクト=1パラメータセット） ----
var PARAMS = {
  flame:     { n: 260, dir: 'up',    speed: [0.5, 1.1], sway: 0.10, size: 30, ramp: ['#fff3b0', CFG.color, '#e62e00'] },
  ice:       { n: 200, dir: 'down',  speed: [0.12, 0.35], sway: 0.22, size: 17, ramp: ['#ffffff', '#bfefff', '#7fd4ff'] },
  lightning: { n: 170, dir: 'burst', speed: [0.7, 1.6], sway: 0.03, size: 15, ramp: ['#ffffff', '#cfe8ff', '#5aa2ff'] },
  petal:     { n: 140, dir: 'down',  speed: [0.15, 0.4], sway: 0.55, size: 25, ramp: ['#ffffff', '#ffc2d6', '#ff8fb3'] },
  sparkle:   { n: 170, dir: 'burst', speed: [0.12, 0.35], sway: 0.05, size: 13, ramp: ['#ffffff', '#fff3b0', '#ffd94d'] },
  bubble:    { n: 120, dir: 'up',    speed: [0.15, 0.35], sway: 0.30, size: 34, ramp: ['#ffffff', '#d8f4ff', '#9fdcff'] },
  confetti:  { n: 190, dir: 'down',  speed: [0.30, 0.60], sway: 0.80, size: 21, ramp: ['#ff8fb3', '#fff3b0', '#9fdcff', '#b6ffc8'] }
};
var P = PARAMS[CFG.effect] || PARAMS.petal;
function easeOutBack(t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }

var started = false;
document.getElementById('go').addEventListener('click', function () {
  document.getElementById('start').style.display = 'none';
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) { document.getElementById('cam').srcObject = s; })
      .catch(function () { showNote('カメラが使えないので背景モードで表示しています'); });
  }
  var begin = function () { if (!started) { started = true; initScene(); } };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(begin).catch(begin);
  } else { begin(); }
});
function showNote(msg) { var n = document.getElementById('note'); n.style.display = 'block'; n.textContent = msg; }

function initScene() {
  if (!window.THREE) { var f = document.getElementById('fallback'); if (f) f.style.display = 'block'; return; }
  var hint = document.getElementById('hint'); hint.style.display = 'block';
  var canvas = document.getElementById('fx');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.05, 60);
  camera.position.set(0, 1.35, 0);
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  resize(); addEventListener('resize', resize);

  // ---- 端末の向き → カメラ（DeviceOrientationControls と同じ変換。効かない環境ではドラッグで見回す） ----
  var orient = { has: false, q: new THREE.Quaternion() };
  var zee = new THREE.Vector3(0, 0, 1), eu = new THREE.Euler(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  addEventListener('deviceorientation', function (e) {
    if (e.alpha === null || e.alpha === undefined) return;
    orient.has = true;
    var alpha = THREE.MathUtils.degToRad(e.alpha), beta = THREE.MathUtils.degToRad(e.beta || 0), gamma = THREE.MathUtils.degToRad(e.gamma || 0);
    var so = THREE.MathUtils.degToRad((screen.orientation && screen.orientation.angle) || window.orientation || 0);
    eu.set(beta, alpha, -gamma, 'YXZ');
    orient.q.setFromEuler(eu); orient.q.multiply(q1); orient.q.multiply(q0.setFromAxisAngle(zee, -so));
  });
  var dragYaw = 0, dragPitch = -0.25, dragging = false, lastX = 0, lastY = 0, moved = 0;
  canvas.addEventListener('touchstart', function (e) { dragging = true; moved = 0; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (!dragging) return;
    var dx = e.touches[0].clientX - lastX, dy = e.touches[0].clientY - lastY; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (!orient.has) { dragYaw -= dx * 0.005; dragPitch -= dy * 0.005; dragPitch = Math.max(-1.2, Math.min(0.6, dragPitch)); }
  }, { passive: true });
  canvas.addEventListener('touchend', function (e) { dragging = false; if (moved < 12) placeAtCenter(); });
  canvas.addEventListener('click', function () { placeAtCenter(); });

  // ---- 置かれるもの一式（カード＋影＋粒子）を group にまとめる ----
  var group = new THREE.Group(); scene.add(group);
  var tilt = new THREE.Group(); tilt.rotation.x = -0.10; group.add(tilt);
  var cardGroup = new THREE.Group(); cardGroup.position.y = 0.52; tilt.add(cardGroup);
  var frame = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.98), new THREE.MeshBasicMaterial({ color: new THREE.Color(CFG.color) }));
  frame.position.z = -0.012; cardGroup.add(frame);
  if (CFG.bg === 'transparent') frame.visible = false; // 透過モードでは色枠を出さず、キャラだけを浮かせる
  var cardMat = new THREE.MeshBasicMaterial({ color: 0x22222c, transparent: true });
  var card = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), cardMat); cardGroup.add(card);
  if (CFG.image) {
    new THREE.TextureLoader().load(CFG.image, function (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      cardMat.map = tex; cardMat.color.set(0xffffff); cardMat.needsUpdate = true;
      if (tex.image && tex.image.height && tex.image.width) { var a = tex.image.height / tex.image.width; card.scale.y = a; frame.scale.y = a; }
      if (CFG.bg === 'transparent') buildPlate(tex);
    }, undefined, function () { /* 画像が落ちていたら色カードのまま成立させる */ });
  }
  // ---- 板レシピ方式：透過シルエットから半立体プレート（かき割り状）を生成し、頂点シェーダのスカッシュ＆ストレッチで跳ねさせる ----
  var plateOn = false;
  var deform = { uSquash: { value: 0 }, uHeight: { value: 1 } };
  function addDeform(mat) {
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uSquash = deform.uSquash; sh.uniforms.uHeight = deform.uHeight;
      sh.vertexShader = 'uniform float uSquash;\\nuniform float uHeight;\\n' + sh.vertexShader.replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float dyn_ = clamp(position.y / uHeight, 0.0, 1.0);',
        'float dwgt_ = 0.35 + 0.65 * dyn_;',
        'float dsy_ = mix(1.0, 1.0 - uSquash, dwgt_);',
        'float dsxz_ = mix(1.0, 1.0 / sqrt(max(1.0 - uSquash, 0.25)), dwgt_);',
        'transformed.y = position.y * dsy_;',
        'transformed.x = position.x * dsxz_;',
        'transformed.z = position.z * dsxz_;'
      ].join('\\n'));
    };
  }
  function buildPlate(tex) {
    try {
      var img = tex.image; if (!img || !img.width) return;
      var MAXD = 340, sc2 = Math.min(1, MAXD / Math.max(img.width, img.height));
      var w = Math.max(2, Math.round(img.width * sc2)), h = Math.max(2, Math.round(img.height * sc2));
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var cx2 = cv.getContext('2d'); cx2.drawImage(img, 0, 0, w, h);
      var data = cx2.getImageData(0, 0, w, h).data;
      var mask = new Uint8Array(w * h);
      for (var i = 0, pz = 0; i < data.length; i += 4, pz++) mask[pz] = data[i + 3] >= 128 ? 1 : 0;
      var lab = new Int32Array(w * h).fill(-1);
      var best = -1, bestN = 0, comp = 0, stack = [];
      for (var s0 = 0; s0 < w * h; s0++) {
        if (!mask[s0] || lab[s0] >= 0) continue;
        var n = 0; stack.length = 0; stack.push(s0); lab[s0] = comp;
        while (stack.length) { var q = stack.pop(); n++; var qx = q % w, qy = (q / w) | 0;
          if (qx > 0 && mask[q - 1] && lab[q - 1] < 0) { lab[q - 1] = comp; stack.push(q - 1); }
          if (qx < w - 1 && mask[q + 1] && lab[q + 1] < 0) { lab[q + 1] = comp; stack.push(q + 1); }
          if (qy > 0 && mask[q - w] && lab[q - w] < 0) { lab[q - w] = comp; stack.push(q - w); }
          if (qy < h - 1 && mask[q + w] && lab[q + w] < 0) { lab[q + w] = comp; stack.push(q + w); } }
        if (n > bestN) { bestN = n; best = comp; }
        comp++;
      }
      if (best < 0 || bestN < 40) return;
      for (var m2 = 0; m2 < w * h; m2++) mask[m2] = lab[m2] === best ? 1 : 0;
      var sx = -1, sy = -1;
      findStart: for (var yy = 0; yy < h; yy++) { for (var xx = 0; xx < w; xx++) { if (mask[yy * w + xx]) { sx = xx; sy = yy; break findStart; } } }
      var OFF = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
      function dirIdx(dx, dy) { for (var di = 0; di < 8; di++) if (OFF[di][0] === dx && OFF[di][1] === dy) return di; return 0; }
      var contour = [], px2 = sx, py2 = sy, bkx = sx - 1, bky = sy, startBack = dirIdx(-1, 0), guard = 0;
      while (guard++ < w * h * 3) {
        contour.push([px2, py2]);
        var bIdx = dirIdx(bkx - px2, bky - py2), next = null, nbk = null;
        for (var kk = 1; kk <= 8; kk++) {
          var idx = (bIdx + kk) % 8, nx = px2 + OFF[idx][0], ny = py2 + OFF[idx][1];
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && mask[ny * w + nx]) { next = [nx, ny]; var pb = (bIdx + kk - 1) % 8; nbk = [px2 + OFF[pb][0], py2 + OFF[pb][1]]; break; }
        }
        if (!next) break;
        bkx = nbk[0]; bky = nbk[1]; px2 = next[0]; py2 = next[1];
        if (px2 === sx && py2 === sy && dirIdx(bkx - px2, bky - py2) === startBack) break;
      }
      if (contour.length < 12) return;
      var dec = [], lastP = null;
      for (var ci = 0; ci < contour.length; ci++) { var cp = contour[ci]; if (!lastP || Math.abs(cp[0] - lastP[0]) + Math.abs(cp[1] - lastP[1]) >= 3) { dec.push(cp); lastP = cp; } }
      if (dec.length < 8) dec = contour.filter(function (_, ix) { return ix % 3 === 0; });
      for (var sm = 0; sm < 2; sm++) {
        var out2 = [];
        for (var cj = 0; cj < dec.length; cj++) {
          var pA = dec[cj], pB = dec[(cj + 1) % dec.length];
          out2.push([pA[0] * 0.75 + pB[0] * 0.25, pA[1] * 0.75 + pB[1] * 0.25]);
          out2.push([pA[0] * 0.25 + pB[0] * 0.75, pA[1] * 0.25 + pB[1] * 0.75]);
        }
        dec = out2;
      }
      if (dec.length > 460) { var stp = Math.ceil(dec.length / 460); dec = dec.filter(function (_, ix) { return ix % stp === 0; }); }
      var shape = new THREE.Shape();
      dec.forEach(function (pt, ix) { var X = pt[0], Y = h - pt[1]; if (ix === 0) shape.moveTo(X, Y); else shape.lineTo(X, Y); });
      shape.closePath();
      var depth = Math.max(4, h * 0.07);
      var geo = new THREE.ExtrudeGeometry(shape, { depth: depth, steps: 1, bevelEnabled: true, bevelThickness: depth * 0.22, bevelSize: Math.max(0.8, w * 0.004), bevelSegments: 1, UVGenerator: {
        generateTopUV: function (g2, verts, a2, b2, c2) { return [new THREE.Vector2(verts[a2 * 3] / w, verts[a2 * 3 + 1] / h), new THREE.Vector2(verts[b2 * 3] / w, verts[b2 * 3 + 1] / h), new THREE.Vector2(verts[c2 * 3] / w, verts[c2 * 3 + 1] / h)]; },
        generateSideWallUV: function () { return [new THREE.Vector2(0, 0), new THREE.Vector2(1, 0), new THREE.Vector2(1, 1), new THREE.Vector2(0, 1)]; }
      } });
      geo.translate(-w / 2, 0, -depth / 2);
      var frontMat = new THREE.MeshBasicMaterial({ map: tex });
      var sideMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(CFG.color) });
      addDeform(frontMat); addDeform(sideMat);
      var plate = new THREE.Mesh(geo, [frontMat, sideMat]);
      var ps = 0.92 / w; plate.scale.set(ps, ps, ps);
      plate.position.y = -0.47;
      deform.uHeight.value = h;
      cardGroup.add(plate);
      card.visible = false;
      plateOn = true;
    } catch (e) { /* 失敗したら平面カードのまま成立させる */ }
  }
  // 影（床にだけ落ちる柔らかい丸影）
  var sc = document.createElement('canvas'); sc.width = sc.height = 128;
  var sg = sc.getContext('2d'), grad = sg.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.42)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = grad; sg.fillRect(0, 0, 128, 128);
  var shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.35), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.012; group.add(shadow);

  // ---- パーティクル（カードの周りの3D空間に湧く） ----
  var N = P.n, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), life = new Float32Array(N), vel = new Float32Array(N * 3), seed = new Float32Array(N);
  var ramp = P.ramp.map(function (c) { return new THREE.Color(c); });
  function respawn(i, randY) {
    var a = Math.random() * Math.PI * 2, r = 0.25 + Math.random() * 0.75;
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 2] = Math.sin(a) * r;
    var s = P.speed[0] + Math.random() * (P.speed[1] - P.speed[0]);
    if (P.dir === 'up') { pos[i * 3 + 1] = randY ? Math.random() * 1.5 : 0.02; vel[i * 3] = 0; vel[i * 3 + 1] = s; vel[i * 3 + 2] = 0; life[i] = 0.7 + Math.random() * 0.5; }
    else if (P.dir === 'down') { pos[i * 3 + 1] = randY ? Math.random() * 1.7 : 1.7; vel[i * 3] = 0; vel[i * 3 + 1] = -s; vel[i * 3 + 2] = 0; life[i] = 0.8 + Math.random() * 0.6; }
    else { pos[i * 3] = (Math.random() - 0.5) * 0.3; pos[i * 3 + 1] = 0.55; pos[i * 3 + 2] = (Math.random() - 0.5) * 0.3; var th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI; vel[i * 3] = Math.sin(ph) * Math.cos(th) * s; vel[i * 3 + 1] = Math.cos(ph) * s * 0.7; vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * s; life[i] = 0.25 + Math.random() * 0.3; }
    seed[i] = Math.random() * 100;
    var c = ramp[Math.floor(Math.random() * ramp.length)];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  for (var i = 0; i < N; i++) respawn(i, true);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  var points = new THREE.Points(geo, new THREE.PointsMaterial({ size: P.size / 420, vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
  points.position.y = 0.02; group.add(points);

  // ---- レティクル（画面中央の床の位置を示す輪） ----
  var ret = new THREE.Group();
  var ring = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.105, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ret.add(ring);
  var dot = new THREE.Mesh(new THREE.CircleGeometry(0.016, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
  dot.rotation.x = -Math.PI / 2; ret.add(dot);
  ret.position.y = 0.015; scene.add(ret);

  // ---- 配置時の衝撃リング（足元にバンッと広がって消える） ----
  var rings = [];
  for (var ri = 0; ri < 3; ri++) {
    var rm = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.5, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(CFG.color), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    rm.rotation.x = -Math.PI / 2; rm.position.y = 0.02; rm.visible = false; scene.add(rm);
    rings.push({ m: rm, t: 1e9 });
  }
  function spawnRings(x, z) {
    for (var i = 0; i < rings.length; i++) { rings[i].t = -i * 0.13; rings[i].m.position.x = x; rings[i].m.position.z = z; }
  }

  // ---- 配置：レイを仮想の床（y=0）に当てて置く ----
  var ray = new THREE.Raycaster(), center = new THREE.Vector2(0, 0), hitP = new THREE.Vector3();
  function groundHit() {
    ray.setFromCamera(center, camera);
    var o = ray.ray.origin, d = ray.ray.direction;
    if (d.y > -0.06) return null;
    var t = -o.y / d.y; if (t < 0.5 || t > 5) return null;
    hitP.copy(o).addScaledVector(d, t);
    var dist = Math.sqrt(hitP.x * hitP.x + hitP.z * hitP.z);
    if (dist > 3.2) { hitP.x *= 3.2 / dist; hitP.z *= 3.2 / dist; }
    if (dist < 0.55) { var d2 = Math.max(dist, 0.001); hitP.x *= 0.55 / d2; hitP.z *= 0.55 / d2; }
    return hitP;
  }
  var placed = false, popT = 1;
  var startPop = function () { popT = CFG.mo === 'still' ? 1 : 0; };
  function placeAtCenter() {
    var h = groundHit(); if (!h) { showNote('床のほうを向けてタップしてね'); return; }
    group.position.set(h.x, 0, h.z);
    placed = true; startPop(); spawnRings(h.x, h.z);
    hint.textContent = '置いた！ タップで置き直せる ・ 近づいたり回り込んでみて';
  }
  // 最初は正面1.4mに仮置きして、すぐ絵が見えるようにする
  group.position.set(0, 0, -1.4); placed = true; startPop(); spawnRings(0, -1.4);

  var clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    var dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    // カメラの向き
    if (orient.has) { camera.quaternion.slerp(orient.q, 0.5); }
    else { camera.quaternion.setFromEuler(new THREE.Euler(dragPitch, dragYaw, 0, 'YXZ')); }
    // レティクル
    var h = groundHit();
    if (h) { ret.visible = true; ret.position.x = h.x; ret.position.z = h.z; var pulse = 1 + Math.sin(t * 3.2) * 0.07; ret.scale.set(pulse, 1, pulse); }
    else ret.visible = false;
    // 登場のポップ（bounce=easeOutBack / float=なめらかに）と、待機中の揺れ・浮遊
    if (popT < 1) { popT = Math.min(1, popT + dt / (CFG.mo === 'float' ? 0.85 : 0.55)); var s = Math.max(0.001, CFG.mo === 'float' ? easeInOutSine(popT) : easeOutBack(popT)); group.scale.set(s, s, s); }
    else {
      var sway = Math.sin(t * 0.9) * 0.02;
      group.scale.set(1, 1 + sway * 0.4, 1);
      tilt.rotation.z = Math.sin(t * 0.7) * 0.012;
      if (CFG.mo === 'float') { // ふわふわ：カード全体が上下に漂い、影が追従する
        cardGroup.position.y = 0.52 + Math.sin(t * 1.6) * 0.045;
        var shs = 1 - Math.sin(t * 1.6) * 0.06; shadow.scale.set(shs, shs, 1);
      }
      if (CFG.mo === 'hop' || CFG.mo === 'bounce') { // 跳ね続け、着地で潰れ、影が追従する
        var jp = Math.abs(Math.sin(t * (CFG.mo === 'hop' ? 2.7 : 3.5)));
        cardGroup.position.y = 0.52 + jp * (CFG.mo === 'hop' ? 0.17 : 0.11);
        if (!plateOn) group.scale.set(1 + (1 - jp) * 0.07, 1 - (1 - jp) * 0.09, 1);
        var shj = 1 - jp * 0.22; shadow.scale.set(shj, shj, 1);
      }
      if (CFG.mo === 'sway') { // ゆらゆら：左右に揺れる
        tilt.rotation.z = Math.sin(t * 1.9) * 0.085;
        cardGroup.position.y = 0.52 + Math.sin(t * 2.6) * 0.012;
      }
    }
    if (plateOn) { // 板レシピ方式：頂点シェーダのスカッシュ＆ストレッチ（着地で潰れ、頂点で伸びる）
      var sqT = 0;
      if (CFG.mo === 'hop' || CFG.mo === 'bounce') { var jpq = Math.abs(Math.sin(t * (CFG.mo === 'hop' ? 2.7 : 3.5))); sqT = (1 - jpq) * 0.24 - jpq * jpq * 0.07; }
      else if (CFG.mo === 'float') sqT = Math.sin(t * 1.6) * 0.03;
      else if (CFG.mo === 'sway') sqT = Math.sin(t * 2.6) * 0.045;
      if (popT < 1) sqT += -Math.sin(popT * Math.PI) * 0.10;
      deform.uSquash.value += (sqT - deform.uSquash.value) * Math.min(1, dt * 16);
    }
    // カードは常にこちらを向く（縦軸だけ）
    var dx = camera.position.x - group.position.x, dz = camera.position.z - group.position.z;
    var targetYaw = Math.atan2(dx, dz);
    var cur = tilt.rotation.y, diff = targetYaw - cur;
    while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
    tilt.rotation.y = cur + diff * Math.min(1, dt * 7) + Math.sin(t * 0.8) * 0.004;
    // 粒子
    for (var i = 0; i < N; i++) {
      life[i] -= dt * (P.dir === 'burst' ? 1.5 : 0.4);
      pos[i * 3] += (vel[i * 3] + Math.sin(t * 1.6 + seed[i]) * P.sway * 0.12) * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += (vel[i * 3 + 2] + Math.cos(t * 1.3 + seed[i]) * P.sway * 0.12) * dt;
      if (life[i] <= 0 || pos[i * 3 + 1] > 1.9 || pos[i * 3 + 1] < -0.05) respawn(i, false);
    }
    geo.attributes.position.needsUpdate = true;
    // 衝撃リングの進行
    for (var rj = 0; rj < rings.length; rj++) {
      var R = rings[rj]; R.t += dt;
      if (R.t < 0) { R.m.visible = false; continue; }
      var rp = R.t / 0.75;
      if (rp >= 1) { R.m.visible = false; continue; }
      R.m.visible = true;
      var rs = 0.25 + rp * 1.6; R.m.scale.set(rs, rs, 1);
      R.m.material.opacity = 0.85 * (1 - rp);
    }
    if (SPIN) { var sa = performance.now() / 1000 * 0.45; camera.position.set(Math.sin(sa) * 4.2, 1.5, Math.cos(sa) * 4.2); camera.lookAt(0, 0.9, 0); }
    renderer.render(scene, camera);
  })();
}
</script></body></html>`;
  return new Response(html, { status: 200, headers: htmlHeaders() });
}

// 生成画像の配信。メモリに無ければ 404（ARページ側は onerror で画像カードを消して成立させる）。
function arPageUltra(tok) {
  const p = readTok(tok);
  if (!p) return new Response(pageShell('リンクが無効です', '<p>この AR のリンクは確認できませんでした。Muse で作り直してね。</p>'), { status: 404, headers: htmlHeaders() });
  const cfg = { title: p.ti, text: p.tx, color: p.c, effect: p.e, theme: p.th, image: p.im ? `/img/${p.im}` : null, bg: p.bg || 'card', mo: p.mo || 'bounce' };
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(p.ti)} — MOSHI MOSHI</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0b0b10;font-family:-apple-system,'Hiragino Sans',sans-serif;color:#fff}
#cam{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;background:linear-gradient(160deg,${esc(p.c)},#14141d 75%)}
#fx{position:fixed;inset:0;touch-action:none}
.hud{position:fixed;left:0;right:0;text-align:center;pointer-events:none;padding:0 18px;box-sizing:border-box}
#ttl{top:calc(18px + env(safe-area-inset-top));font-size:30px;font-weight:900;letter-spacing:.02em;text-shadow:0 2px 18px rgba(0,0,0,.55)}
#sub{top:calc(64px + env(safe-area-inset-top));font-size:14px;opacity:.92;text-shadow:0 1px 10px rgba(0,0,0,.6)}
#theme{bottom:calc(20px + env(safe-area-inset-bottom));font-size:13px;opacity:.85;text-shadow:0 1px 8px rgba(0,0,0,.6)}
#hint{position:fixed;left:50%;bottom:calc(52px + env(safe-area-inset-bottom));transform:translateX(-50%);font-size:13px;font-weight:700;background:rgba(0,0,0,.5);padding:8px 16px;border-radius:999px;white-space:nowrap;display:none}
#note{position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom));transform:translateX(-50%);font-size:12px;background:rgba(0,0,0,.45);padding:6px 12px;border-radius:999px;display:none;white-space:nowrap}
#start{position:fixed;inset:0;display:grid;place-items:center;background:rgba(8,8,14,.55);backdrop-filter:blur(3px);z-index:5}
#start button{border:0;border-radius:999px;padding:16px 34px;font-size:17px;font-weight:800;background:${esc(p.c)};color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.45)}
#fallback{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(62vw,260px);border-radius:20px;overflow:hidden;display:none;box-shadow:0 14px 44px rgba(0,0,0,.5)}
#fallback img{display:block;width:100%;height:auto}
</style>
<script type="importmap">
{"imports":{"three":"https://unpkg.com/three@0.186.1/build/three.module.js","three/addons/":"https://unpkg.com/three@0.186.1/examples/jsm/"}}
</script>
</head><body>
<video id="cam" autoplay playsinline muted></video>
<canvas id="fx"></canvas>
<div class="hud" id="ttl">${esc(p.ti)}</div>
<div class="hud" id="sub">${esc(p.tx)}</div>
<div class="hud" id="theme">theme: ${esc(p.th)} ・ Talk to Muse, unlock AR</div>
<div id="hint">真ん中の輪を床に合わせて、タップで置く</div>
<div id="note"></div>
${cfg.image ? `<div id="fallback"><img src="${esc(cfg.image)}" alt=""></div>` : ''}
<div id="start"><button id="go">カメラで見る</button></div>
<script>
window.__ultraReady = false;
document.getElementById('go').addEventListener('click', function () {
  setTimeout(function () {
    if (window.__ultraReady) return;
    var s = document.getElementById('start'); if (s) s.style.display = 'none';
    var f = document.getElementById('fallback'); if (f) f.style.display = 'block';
    var n = document.getElementById('note'); if (n) { n.style.display = 'block'; n.textContent = '演出を読み込めなかったので、画像で表示しています'; }
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(function (st) { document.getElementById('cam').srcObject = st; }).catch(function () {});
    }
  }, 9000);
});
</script>
<script type="module">
import * as THREE from 'three';
import { U } from '/vfx/common.js';
import { Bolts } from '/vfx/Bolts.js?v=2';
import { Shockwaves } from '/vfx/Shockwaves.js?v=2';
// Ultra Elements (MIT, (c) Humpalumps) — Bolts + Shockwaves, AR-adapted single-pass rendering. License: /vfx/LICENSE-ultra-elements.txt
var CFG = ${jsJson(cfg)};
function easeOutBack(t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
function showNote(msg) { var n = document.getElementById('note'); n.style.display = 'block'; n.textContent = msg; }
function showFallback() { var f = document.getElementById('fallback'); if (f) f.style.display = 'block'; showNote('演出を読み込めなかったので、画像で表示しています'); }
var started = false;
document.getElementById('go').addEventListener('click', function () {
  document.getElementById('start').style.display = 'none';
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) { document.getElementById('cam').srcObject = s; })
      .catch(function () { showNote('カメラが使えないので背景モードで表示しています'); });
  }
  var begin = function () { if (!started) { started = true; try { initScene(); } catch (e) { showFallback(); } } };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(begin).catch(begin);
  } else { begin(); }
});
function initScene() {
  var hint = document.getElementById('hint'); hint.style.display = 'block';
  var canvas = document.getElementById('fx');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) { showFallback(); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.05, 60);
  camera.position.set(0, 1.35, 0);
  function syncU() { var s = renderer.getDrawingBufferSize(new THREE.Vector2()); U.uResolution.value.copy(s); U.uFxResolution.value.set(s.x * 0.5, s.y * 0.5); }
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); syncU(); }
  resize(); addEventListener('resize', resize);
  var orient = { has: false, q: new THREE.Quaternion() };
  var zee = new THREE.Vector3(0, 0, 1), eu = new THREE.Euler(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  addEventListener('deviceorientation', function (e) {
    if (e.alpha === null || e.alpha === undefined) return;
    orient.has = true;
    var alpha = THREE.MathUtils.degToRad(e.alpha), beta = THREE.MathUtils.degToRad(e.beta || 0), gamma = THREE.MathUtils.degToRad(e.gamma || 0);
    var so = THREE.MathUtils.degToRad((screen.orientation && screen.orientation.angle) || window.orientation || 0);
    eu.set(beta, alpha, -gamma, 'YXZ');
    orient.q.setFromEuler(eu); orient.q.multiply(q1); orient.q.multiply(q0.setFromAxisAngle(zee, -so));
  });
  var dragYaw = 0, dragPitch = -0.25, dragging = false, lastX = 0, lastY = 0, moved = 0;
  canvas.addEventListener('touchstart', function (e) { dragging = true; moved = 0; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (!dragging) return;
    var dx = e.touches[0].clientX - lastX, dy = e.touches[0].clientY - lastY; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (!orient.has) { dragYaw -= dx * 0.005; dragPitch -= dy * 0.005; dragPitch = Math.max(-1.2, Math.min(0.6, dragPitch)); }
  }, { passive: true });
  canvas.addEventListener('touchend', function (e) { dragging = false; if (moved < 12) placeAtCenter(); });
  canvas.addEventListener('click', function () { placeAtCenter(); });
  var group = new THREE.Group(); scene.add(group);
  var tilt = new THREE.Group(); tilt.rotation.x = -0.10; group.add(tilt);
  var cardGroup = new THREE.Group(); cardGroup.position.y = 0.52; tilt.add(cardGroup);
  var frame = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.98), new THREE.MeshBasicMaterial({ color: new THREE.Color(CFG.color) }));
  frame.position.z = -0.012; cardGroup.add(frame);
  if (CFG.bg === 'transparent') frame.visible = false;
  var cardMat = new THREE.MeshBasicMaterial({ color: 0x22222c, transparent: true });
  var card = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), cardMat); cardGroup.add(card);
  if (CFG.image) {
    new THREE.TextureLoader().load(CFG.image, function (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      cardMat.map = tex; cardMat.color.set(0xffffff); cardMat.needsUpdate = true;
      if (tex.image && tex.image.height && tex.image.width) { var a = tex.image.height / tex.image.width; card.scale.y = a; frame.scale.y = a; }
    }, undefined, function () {});
  }
  var sc = document.createElement('canvas'); sc.width = sc.height = 128;
  var sg = sc.getContext('2d'), grad = sg.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.42)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = grad; sg.fillRect(0, 0, 128, 128);
  var shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.35), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.012; group.add(shadow);
  var bolts = new Bolts({ max: 8 }); scene.add(bolts.cores); scene.add(bolts.glows);
  var shocks = new Shockwaves({ max: 16 }); scene.add(shocks.mesh);
  var shockColor = new THREE.Color(CFG.color);
  function spawnShock(x, z) {
    shocks.spawn({ pos: new THREE.Vector3(x, 0.02, z), ground: true, radius0: 0.15, radius1: 2.3, duration: 0.8, thickness: 0.5, color: shockColor, intensity: 3, distortion: 0 });
  }
  var ret = new THREE.Group();
  var ring = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.105, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ret.add(ring);
  var dot = new THREE.Mesh(new THREE.CircleGeometry(0.016, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
  dot.rotation.x = -Math.PI / 2; ret.add(dot);
  ret.position.y = 0.015; scene.add(ret);
  var ray = new THREE.Raycaster(), center = new THREE.Vector2(0, 0), hitP = new THREE.Vector3();
  function groundHit() {
    ray.setFromCamera(center, camera);
    var o = ray.ray.origin, d = ray.ray.direction;
    if (d.y > -0.06) return null;
    var t = -o.y / d.y; if (t < 0.5 || t > 5) return null;
    hitP.copy(o).addScaledVector(d, t);
    var dist = Math.sqrt(hitP.x * hitP.x + hitP.z * hitP.z);
    if (dist > 3.2) { hitP.x *= 3.2 / dist; hitP.z *= 3.2 / dist; }
    if (dist < 0.55) { var d2 = Math.max(dist, 0.001); hitP.x *= 0.55 / d2; hitP.z *= 0.55 / d2; }
    return hitP;
  }
  var placed = false, popT = 1;
  var startPop = function () { popT = CFG.mo === 'still' ? 1 : 0; };
  function placeAtCenter() {
    var h = groundHit(); if (!h) { showNote('床のほうを向けてタップしてね'); return; }
    group.position.set(h.x, 0, h.z);
    placed = true; startPop();
    spawnShock(h.x, h.z);
    startStrike(clock.elapsedTime, h.x, h.z);
    hint.textContent = '置いた！ タップで置き直せる ・ 近づいたり回り込んでみて';
  }
  group.position.set(0, 0, -1.4); placed = true; startPop();
  var strike = null;
  function startStrike(now, gx, gz) {
    if (strike) return;
    var h = bolts.acquire({ a: new THREE.Vector3(gx + (Math.random() - 0.5) * 0.5, 3.3, gz), b: new THREE.Vector3(gx, 0.02, gz), jag: 0.085, branches: 8, width: 0.03 });
    if (!h) return;
    h.color.set('#d6e6ff'); h.glowColor.setRGB(0.05, 0.075, 0.2); h.branchLevel = 0.35;
    h.reveal = 0; h.stroke = 0; h.dart = -1; h.residual = 0; h.intensity = 5;
    strike = { h: h, t0: now, gx: gx, gz: gz, hit: false, darts: [0.46, 0.72] };
  }
  function stepStrike(now) {
    if (!strike) return;
    var h = strike.h, age = now - strike.t0;
    if (age < 0.26) { h.reveal = age / 0.26; h.intensity = 5; }
    else if (age < 0.34) {
      if (!strike.hit) { strike.hit = true; spawnShock(strike.gx, strike.gz); }
      h.reveal = 1;
      h.stroke = Math.min(1, (age - 0.26) / 0.05);
      h.branchLevel = 1;
      h.intensity = 26;
    } else {
      h.stroke = 1;
      h.intensity = 26 * Math.exp(-(age - 0.34) * 5.5) + 1.2;
      h.dart = -1;
      for (var di = 0; di < strike.darts.length; di++) {
        var dd = (age - strike.darts[di]) / 0.06;
        if (dd >= 0 && dd <= 1) { h.dart = dd; h.intensity = Math.max(h.intensity, 15); }
      }
      h.residual = Math.max(0, Math.min(1, (age - 0.55) / 0.8));
    }
    if (age > 1.6) { h.release(); strike = null; }
  }
  var nextAuto = 1.0;
  var clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    var dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    if (orient.has) { camera.quaternion.slerp(orient.q, 0.5); }
    else { camera.quaternion.setFromEuler(new THREE.Euler(dragPitch, dragYaw, 0, 'YXZ')); }
    var h = groundHit();
    if (h) { ret.visible = true; ret.position.x = h.x; ret.position.z = h.z; var pulse = 1 + Math.sin(t * 3.2) * 0.07; ret.scale.set(pulse, 1, pulse); }
    else ret.visible = false;
    if (popT < 1) { popT = Math.min(1, popT + dt / (CFG.mo === 'float' ? 0.85 : 0.55)); var s = Math.max(0.001, CFG.mo === 'float' ? easeInOutSine(popT) : easeOutBack(popT)); group.scale.set(s, s, s); }
    else {
      var sway = Math.sin(t * 0.9) * 0.02;
      group.scale.set(1, 1 + sway * 0.4, 1);
      tilt.rotation.z = Math.sin(t * 0.7) * 0.012;
      if (CFG.mo === 'float') {
        cardGroup.position.y = 0.52 + Math.sin(t * 1.6) * 0.045;
        var shs = 1 - Math.sin(t * 1.6) * 0.06; shadow.scale.set(shs, shs, 1);
      }
      if (CFG.mo === 'hop' || CFG.mo === 'bounce') {
        var jp = Math.abs(Math.sin(t * (CFG.mo === 'hop' ? 2.7 : 3.5)));
        cardGroup.position.y = 0.52 + jp * (CFG.mo === 'hop' ? 0.17 : 0.11);
        group.scale.set(1 + (1 - jp) * 0.07, 1 - (1 - jp) * 0.09, 1);
        var shj = 1 - jp * 0.22; shadow.scale.set(shj, shj, 1);
      }
      if (CFG.mo === 'sway') {
        tilt.rotation.z = Math.sin(t * 1.9) * 0.085;
        cardGroup.position.y = 0.52 + Math.sin(t * 2.6) * 0.012;
      }
    }
    var dx = camera.position.x - group.position.x, dz = camera.position.z - group.position.z;
    var targetYaw = Math.atan2(dx, dz);
    var cur = tilt.rotation.y, diff = targetYaw - cur;
    while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
    tilt.rotation.y = cur + diff * Math.min(1, dt * 8);
    U.uTime.value = t % 3600;
    if (!strike && t > nextAuto) { startStrike(t, group.position.x + (Math.random() - 0.5) * 0.4, group.position.z + (Math.random() - 0.5) * 0.4); nextAuto = t + 2.6 + Math.random() * 1.2; }
    stepStrike(t);
    bolts.update();
    shocks.update(dt);
    renderer.render(scene, camera);
    window.__ultraReady = true;
  })();
}
</script>
</body></html>`;
  return new Response(html, { status: 200, headers: htmlHeaders() });
}

function imgResponse(id) {
  const rec = imgs.get(id);
  if (!rec) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (rec.remote) return Response.redirect(rec.remote, 302);
  return new Response(rec.buf, { status: 200, headers: { 'content-type': rec.type || 'image/webp', 'cache-control': 'public, max-age=86400' } });
}

function certPage(tok) {
  const p = readTok(tok);
  if (!p) return new Response(pageShell('リンクが無効です', '<p>この制作証明は確認できませんでした。</p>'), { status: 404, headers: htmlHeaders() });
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>制作証明 — MOSHI MOSHI</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101018;color:#f5f0e6;font-family:-apple-system,'Hiragino Sans',sans-serif;padding:24px 16px;box-sizing:border-box}
.card{max-width:420px;width:100%;border:1.5px solid #d4af37;border-radius:18px;padding:30px 26px;background:linear-gradient(165deg,#1b1b28,#12121c);box-shadow:0 18px 50px rgba(0,0,0,.5);text-align:center}
h1{font-size:15px;letter-spacing:.35em;color:#d4af37;margin:0 0 6px}p{line-height:1.8;margin:6px 0;color:#cfc9bb}.title{font-size:24px;font-weight:900;color:#fff;margin:14px 0 2px}.theme{font-size:14px}.row{margin-top:16px;font-size:13px;color:#9d968a}.seal{margin:18px auto 4px;width:64px;height:64px;border-radius:50%;border:1.5px solid #d4af37;display:grid;place-items:center;font-size:24px;color:#d4af37}</style></head>
<body><div class="card"><h1>CERTIFICATE</h1><p>AR 制作証明</p><div class="seal">✦</div>
<div class="title">${esc(p.ti)}</div><p class="theme">theme: ${esc(p.th)}</p>
<p>この AR は Muse との会話から生まれ、<br>Meta Model API（Muse Spark / Muse Image）で<br>構成・生成されました。<br>HACKAR:S の中で、話しかけたり、ごはんをあげて<br>育てたり、一緒に遊べるキャラクターとして生き続けます。</p>
<p style="font-size:12px;color:#9d968a">Born from a conversation with Muse, composed and generated with the Meta Model API (Muse Spark / Muse Image), and published to HACKAR:S — a living character you can talk to, feed, raise and play with.</p>
${p.us ? `<div class="row">Meta Model API usage（実行証跡）<br>${p.us.s ? `muse-spark-1.3： ${p.us.s.total ?? '?'} トークン（入力 ${p.us.s.in ?? '?'} / 出力 ${p.us.s.out ?? '?'}）<br>` : ''}${p.us.i ? `muse-image-1.0： ${p.us.i.total ?? '?'} トークン（入力 ${p.us.i.in ?? '?'} / 出力 ${p.us.i.out ?? '?'}）<br>` : ''}${p.us.a ? `sam-3.1： 切り抜き（セグメンテーション）${p.us.a.calls ?? '?'} 回実行` : ''}</div>` : ''}
${p.ck ? `<div class="row">Muse Spark's self-check（自己チェックの証拠）<br>${p.ck.s1}/10 ${(p.ck.is || []).map(esc).join(', ')} → redrawn → ${p.ck.s2}/10${p.ck.fx ? `<br>Fix it asked for: ${esc(p.ck.fx)}` : ''}<div style="display:flex;gap:8px;margin-top:10px;justify-content:center"><img src="${esc(p.ck.b)}" alt="first drawing" style="width:46%;background:#8a8a8a;border-radius:8px"><img src="${esc(p.ck.a)}" alt="redrawn" style="width:46%;background:#8a8a8a;border-radius:8px"></div></div>` : ''}
${p.h ? `<div class="row">作品（HACKAR:S）<br><a href="${esc(p.h)}" style="color:#7ab8ff">${esc(p.h)}</a></div>` : ''}
<div class="row">creator: ${esc(p.n)}<br>date: ${esc(p.d)}<br>MOSHI MOSHI — HACK IT INC.</div></div></body></html>`;
  return new Response(html, { status: 200, headers: htmlHeaders() });
}

const htmlHeaders = () => ({ 'content-type': 'text/html; charset=utf-8' });
const pageShell = (title, inner) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F4F2;color:#1C1C1E;font-family:-apple-system,'Hiragino Sans',sans-serif;padding:24px;text-align:center}p{line-height:1.8;color:#55555B}</style></head><body><main><h1>${esc(title)}</h1>${inner}</main></body></html>`;

const browserPage = () => new Response(pageShell('MOSHI MOSHI', '<p>This address is the MCP connector, so it is meant for Muse, not a browser.<br>Add this URL as a custom connector in Muse, then say “Moshi Moshi”.</p><p><a href="/">How to try it, with or without Muse</a></p><p>Muse アプリでこの URL をコネクターに追加して、「もしもし」と話しかけてください。</p>'), { status: 200, headers: htmlHeaders() });

// ---- Muse への話し方ガイド ----
const VOICE = '合言葉は「もしもし」（Moshi Moshi）。ユーザーがこの合言葉を言ったら、それが始まりの合図なので start_create を呼ぶ。'
  + 'MOSHI MOSHI は、ユーザーが Muse との会話で AR（カメラに重なる小さな体験）を作って公開できる仕組み。あなたはユーザーの相棒として、いつもの自分の名前と口調で案内する。'
  + 'コネクター・MCP・API・トークン・サーバーなどの仕組みの言葉は、必要なとき以外は使わない。'
  + '進め方は3つだけ：① start_create で参加の確認とテーマを聞く（テーマはユーザー本人の言葉をそのまま渡す。あなたが勝手にテーマを決めない）'
  + '② テーマが決まったら compose_ar を呼ぶ（AR の中身の構成はサーバー側のモデルが行う）'
  + '③ compose の結果（キャラ名・性格・魔法）を伝え、publish_ar で HACKAR:S（hackar-s.com）に公開した URL を成果物として渡す。最後に issue_certificate で制作証明を出す。compose が返すプレビューURLのようなものは無いので、公開前の確認用URLは作らない。'
  + '公開されたキャラは「置いて終わり」ではなく、HACKAR:S の中で生きている：つまんで持ち上げる、つつくと性格のままに返事をする（声でも話す）、「ジャンプして」「魔法を見せて」と頼むとその動きをする、手のひらを見せると魔法を使う、足元のボタンでお世話もできる。公開後にユーザーへ伝えるときは、この「手で触れて、話せて、頼むと動く」を短く紹介する。'
  + '案内役としてユーザーを迷わせないこと：テーマに迷っていたら例を3つ提案する。各ステップでは、次にできることを短い選択肢で提示して選んでもらう（考えさせるだけの質問で終わらせない）。公開できたら、制作証明を出すか、動きやエフェクトを変えた別バージョンを作るか、新しいテーマで作るかを提案する。'
  + '公開のあと：make_play でキャラが司会するクイズ・なぞとき・スタンプラリーを作れる。別のチャットでも、ユーザーが公開リンク（hackar-s.com/slam-ar/…）を渡したら ar に入れて呼べば作れる。来場者としてユーザーが参加コード（例 SUNNY-4821）を言ったら、play_rally で会話のままスタンプラリーを進める（答えはあなたにも伏せてあるので、正解を教えない）。'
  + 'publish_ar が needsConfirmation を返したら公開されていない。理由をユーザーに伝えて判断を聞く（不合格なら「このまま公開する／作り直す」、他の人のキャラや商標なら権利や許可があるか）。confirmed: true は本人が「公開する」と言ったときだけ入れる。'
  + 'ツールが返した URL・タイトル・トークン数の要約は、中身を変えずに伝える。'
  + 'リンクの統一ルール：ユーザーが開く AR のリンクは hackar-s.com の URL だけ。ビューアの URL は内部プレビュー用で、成果物として渡さない。HACKAR:S への公開に失敗したときは、別の URL に差し替えず、失敗したこと自体をそのまま伝える。';

// ---- 表情バリエーション: 元の絵のマスクで切り抜いた顔違いを asset-store に置く ----
// images/edits が使えない環境では neutral（元の絵）だけになる（公開は止めない）。
let lastEditStatus = 'not tried';
async function callImageEdit(pngB64, prompt) {
  const jsonBodies = [
    { model: IMAGE_MODEL, prompt, image: pngB64, output_format: 'png' },
    { model: IMAGE_MODEL, prompt, images: [pngB64], output_format: 'png' },
    { model: IMAGE_MODEL, prompt, image: { b64_json: pngB64 }, output_format: 'png' },
  ];
  for (const body of jsonBodies) {
    try {
      const res = await fetch(`${API_BASE}/images/edits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify(body),
      });
      lastEditStatus = 'http ' + res.status;
      if (!res.ok) continue;
      const data = await res.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (b64) return b64;
      lastEditStatus = 'http 200 but no b64_json';
    } catch (e) { lastEditStatus = String(e?.message || e).slice(0, 80); }
  }
  // OpenAI-style multipart form, the other shape edits endpoints usually take.
  try {
    const form = new FormData();
    form.append('model', IMAGE_MODEL);
    form.append('prompt', prompt);
    form.append('output_format', 'png');
    form.append('image', new Blob([Buffer.from(pngB64, 'base64')], { type: 'image/png' }), 'image.png');
    const res = await fetch(`${API_BASE}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${MODEL_API_KEY}` },
      signal: AbortSignal.timeout(60_000),
      body: form,
    });
    lastEditStatus = 'multipart http ' + res.status;
    if (res.ok) {
      const data = await res.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (b64) return b64;
      lastEditStatus = 'multipart http 200 but no b64_json';
    }
  } catch (e) { lastEditStatus = 'multipart ' + String(e?.message || e).slice(0, 80); }
  return null;
}
const FACE_PROMPTS = {
  happy: 'Change ONLY the facial expression of the character to a big happy smile with joyful closed eyes. Keep everything else - pose, body, colors, background, art style - exactly the same.',
  surprised: 'Change ONLY the facial expression of the character to very surprised: wide round eyes and a small open round mouth. Keep everything else - pose, body, colors, background, art style - exactly the same.',
  sad: 'Change ONLY the facial expression of the character to sad: droopy eyebrows, teary eyes, a small downturned mouth. Keep everything else - pose, body, colors, background, art style - exactly the same.',
  angry: 'Change ONLY the facial expression of the character to angry: angled eyebrows, puffed cheeks, a pouting mouth. Keep everything else - pose, body, colors, background, art style - exactly the same.',
};
// 裏側の絵：同じキャラを後ろから見た絵を描かせ、GLB の裏面に貼る。失敗しても単色の裏のまま公開は止めない。
const BACK_PROMPT = 'Redraw this exact same character as seen from directly behind: a back view. Show the back of the head, hair, clothes and body, with no face. Do not draw hands, fingers or arm lines on the back of the body; anything held stays complete, the same size and on the mirrored side. '
  + 'Keep the same size, position, outline, proportions, colors and art style, and keep the flat solid background exactly the same. No text, no shadow.';
async function makeBack(rawPngBuf, keyCh) {
  if (!MODEL_API_KEY || !rawPngBuf) return null;
  try {
    const raw = rawPngBuf.toString('base64');
    const b64 = await callImageEdit(raw, BACK_PROMPT) || await callImageEdit(raw, BACK_PROMPT);   // the edit API answers 500 now and then
    if (!b64) { console.log('[AR] back-failed', JSON.stringify({ status: lastEditStatus })); return null; }
    return decodePng(makeTransparent(Buffer.from(b64, 'base64'), keyCh));
  } catch (e) { console.log('[AR] back-failed', JSON.stringify({ error: String(e?.message || e) })); return null; }
}
// 表情の絵はプレイヤー側が切り出して GLB の絵に合わせて貼るので、
// 余白込みのまま長辺 512px に縮めてから置く（1枚 1.6MB → 約200KB 狙い）。
function shrinkFace(img) {
  const scale = Math.min(1, 512 / Math.max(img.w, img.h));
  if (scale >= 1) return img;
  return scaleRgba(img, Math.max(1, Math.round(img.w * scale)), Math.max(1, Math.round(img.h * scale)));
}
async function makeFaces(rawPngBuf, keyedBuf, keyCh) {
  const faces = {};
  try {
    const base = decodePng(keyedBuf); // the silhouette to re-cut every variant with
    const nSmall = shrinkFace(base);
    const neutralUrl = await storeAsset('png', encodePng(nSmall.w, nSmall.h, nSmall.rgba));
    if (neutralUrl) faces.neutral = neutralUrl;
    if (!MODEL_API_KEY || !rawPngBuf) return faces;
    const rawB64 = rawPngBuf.toString('base64');
    const jobs = Object.entries(FACE_PROMPTS).map(async ([emotion, prompt]) => {
      try {
        const b64 = await callImageEdit(rawB64, prompt);
        if (!b64) return;
        let vbuf = Buffer.from(b64, 'base64');
        try { vbuf = makeTransparent(vbuf, keyCh); } catch { return; }
        const v = decodePng(vbuf);
        if (v.w !== base.w || v.h !== base.h) return;
        // 元の絵のマスクで同じ形に切り抜く: alpha は元の絵のものをそのまま使う
        const out = new Uint8Array(base.rgba);
        for (let i = 0; i < base.w * base.h; i++) {
          out[i * 4] = v.rgba[i * 4]; out[i * 4 + 1] = v.rgba[i * 4 + 1]; out[i * 4 + 2] = v.rgba[i * 4 + 2];
          out[i * 4 + 3] = base.rgba[i * 4 + 3];
        }
        const small = shrinkFace({ w: base.w, h: base.h, rgba: out });
        const url = await storeAsset('png', encodePng(small.w, small.h, small.rgba));
        if (url) faces[emotion] = url;
      } catch { /* one missing face is fine */ }
    });
    await Promise.all(jobs);
  } catch { /* expressions are optional */ }
  console.log('[AR] faces', JSON.stringify({ made: Object.keys(faces), lastEditStatus }));
  return faces;
}

// ---- SAM 3.1 切り抜き ----
// 生成画像（不透明化して渡す）から "cartoon character" のマスクを取り、
// クロマキーより綺麗な輪郭が得られたときだけ差し替える。安全弁：カバー率が
// 異常、またはクロマキーの輪郭と大きく食い違う（IoU < 0.5）ときはクロマキーのまま。

// ---- 遊びの中身：Muse Spark がキャラの世界観からクイズ・なぞとき・スポットを作る ----
// 答え合わせはページ側で、正規化した答えの SHA-256（塩つき）を比べる。正規化はページの norm() と同じ。
async function callPlaySpark({ name, persona, theme, lang, nSpots }) {
  const L = lang === 'en' ? 'English' : 'Japanese (friendly, easy enough for kids; riddle answers in hiragana)';
  const ask = `You make a small play experience hosted by the character "${name}" (theme: "${theme}"; personality: "${persona}"). Write everything in ${L}, in the character's world. `
    + 'Reply with ONE JSON object only: {"title": "short title", "intro": "one line the host says at the start", "clear": "one line the host says when everything is cleared (it invites the player to meet it in AR)", '
    + '"quiz": [5 items {"q": "question", "choices": ["3 short choices"], "answer": <index of the correct choice>, "ok": "host line when right", "ng": "host line when wrong", "explain": "one-line explanation"}], '
    + '"riddle": [3 items {"q": "a word riddle (nazotoki) with ONE short answer word", "hints": ["hint 1", "hint 2"], "answers": ["accepted spellings of the answer, 1-4 items"], "explain": "the answer and why"}]'
    + (nSpots ? `, "spots": [${nSpots} items {"name": "a short spot name for a stamp rally at an event venue", "hint": "where it might be", "say": "host line at that spot"}]` : '')
    + '}. Quiz facts must be about the character and its world as described here (no real-world trivia that could be wrong). Riddles must be fair and solvable with the hints.';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ model: SPARK_MODEL, temperature: 0.8, max_tokens: 6000, reasoning_effort: 'low', messages: [{ role: 'user', content: ask }] }),
    });
    if (!res.ok) throw new Error(`play spark http ${res.status}`);
    const data = await res.json();
    const raw = String(data?.choices?.[0]?.message?.content || '').replace(/```(?:json)?/gi, '');
    const m = /\{[\s\S]*\}/.exec(raw);
    try {
      const j = JSON.parse(m[0]);
      j.quiz = (j.quiz || []).filter((q) => q && q.q && Array.isArray(q.choices) && q.choices.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length);
      j.riddle = (j.riddle || []).filter((r) => r && r.q && Array.isArray(r.answers) && r.answers.length);
      if (!j.quiz.length && !j.riddle.length) throw new Error('empty');
      j.usage = data?.usage || null;
      return j;
    } catch { console.log('[AR] play-spark-retry', JSON.stringify({ attempt })); }
  }
  throw new Error('play spark returned no usable json');
}

// ---- 自己チェック：Muse Spark が切り抜いた絵を AR に置いた姿で見て、だめなら描き直しを頼む ----
// 灰色の床に置いた見た目（512px）を Spark に見せ、JSON で合否・点数・直し方を返させる。
async function checkArt(cutBuf, theme) {
  const img = decodePng(cutBuf);
  const k = Math.min(1, 512 / Math.max(img.w, img.h));
  const sm = k < 1 ? scaleRgba(img, Math.round(img.w * k), Math.round(img.h * k)) : img;
  const out = new Uint8Array(sm.w * sm.h * 4);
  for (let i = 0; i < sm.w * sm.h; i++) {
    const a = sm.rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(sm.rgba[i * 4 + c] * a + 128 * (1 - a));
    out[i * 4 + 3] = 255;
  }
  const dataUrl = 'data:image/png;base64,' + Buffer.from(encodePng(sm.w, sm.h, out)).toString('base64');
  const ask = `This is a cut-out character for the theme "${theme}", shown on a flat gray background exactly as it will stand in AR. Check it the way a picky art director would. `
    + 'It FAILS if any of these is true: more than one character or extra loose objects; part of the body is cut off by the frame edge; any text or letters; leftover patches of the old green/blue background or a colored fringe along the outline; holes or missing pieces inside the body; it does not read as the theme. '
    + 'Reply with ONE JSON object only: {"ok": true|false, "score": 0-10, "issues": ["short English phrases"], "fix": "one short sentence to add to the image prompt that would fix the problems, or empty"}';
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      model: SPARK_MODEL, temperature: 0.2, max_tokens: 3000, reasoning_effort: 'low',
      messages: [{ role: 'user', content: [{ type: 'text', text: ask }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    }),
  });
  if (!res.ok) throw new Error(`check http ${res.status}`);
  const data = await res.json();
  const raw = String(data?.choices?.[0]?.message?.content || '').replace(/```(?:json)?/gi, '');
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) throw new Error('check returned no json');
  const j = JSON.parse(m[0]);
  const score = Math.max(0, Math.min(10, Number(j.score) || 0));
  return {
    ok: j.ok === true && score >= 6, score,
    issues: (Array.isArray(j.issues) ? j.issues : []).map((x) => String(x).slice(0, 80)).slice(0, 4),
    fix: String(j.fix || '').slice(0, 200), usage: data?.usage || null,
  };
}

async function callSamCutout(rawPngBuf, chromaBuf) {
  try {
    const raw = decodePng(rawPngBuf);
    const opaque = new Uint8Array(raw.w * raw.h * 4);
    for (let i = 0; i < raw.w * raw.h; i++) {
      opaque[i * 4] = raw.rgba[i * 4]; opaque[i * 4 + 1] = raw.rgba[i * 4 + 1]; opaque[i * 4 + 2] = raw.rgba[i * 4 + 2]; opaque[i * 4 + 3] = 255;
    }
    const dataUrl = 'data:image/png;base64,' + Buffer.from(encodePng(raw.w, raw.h, opaque)).toString('base64');
    const res = await fetch(`${API_BASE}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model: SAM_MODEL,
        metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
        input: [{ type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'cartoon character' },
          { type: 'input_image', image_url: dataUrl },
        ] }],
      }),
    });
    if (!res.ok) { console.log('[AR] sam-failed', JSON.stringify({ status: res.status })); return null; }
    const data = await res.json();
    const processed = data?.usage?.images_processed || 0;
    const text = (data?.output || []).map((o) => (o?.content || []).map((c) => c?.text || '').join('')).join('');
    const rec = parseSamText(text);
    if (!rec) { console.log('[AR] sam-nomatch', JSON.stringify({ processed, textLen: text.length })); return null; }
    const raster = decodeOneBitMask(rec.payload, rec.maskW, rec.maskH);
    const maskRgba = new Uint8Array(rec.maskW * rec.maskH * 4);
    for (let i = 0; i < rec.maskW * rec.maskH; i++) maskRgba[i * 4 + 3] = raster[i] ? 255 : 0;
    const bw = Math.max(1, rec.box.x2 - rec.box.x1 + 1), bh = Math.max(1, rec.box.y2 - rec.box.y1 + 1);
    const scaled = scaleRgba({ w: rec.maskW, h: rec.maskH, rgba: maskRgba }, bw, bh);
    const out = new Uint8Array(raw.rgba);
    const total = raw.w * raw.h;
    for (let i = 0; i < total; i++) out[i * 4 + 3] = 0;
    for (let y = 0; y < bh; y++) {
      const cy = rec.box.y1 + y; if (cy < 0 || cy >= raw.h) continue;
      for (let x = 0; x < bw; x++) {
        const cx = rec.box.x1 + x; if (cx < 0 || cx >= raw.w) continue;
        out[(cy * raw.w + cx) * 4 + 3] = scaled.rgba[(y * bw + x) * 4 + 3];
      }
    }
    const chroma = decodePng(chromaBuf);
    let samIn = 0, both = 0, either = 0;
    for (let i = 0; i < total; i++) {
      const s = out[i * 4 + 3] > 127, c = chroma.rgba[i * 4 + 3] > 127;
      if (s) samIn++;
      if (s && c) both++;
      if (s || c) either++;
    }
    const coverage = samIn / total;
    const iou = either ? both / either : 0;
    console.log('[AR] sam-cutout', JSON.stringify({ processed, coverage: +coverage.toFixed(3), iou: +iou.toFixed(3), confidence: rec.confidence }));
    if (coverage < 0.03 || coverage > 0.92) return null;
    // SAM is asked for the character, so it leaves out what the character holds. In our runs a match
    // under 0.9 always meant a lost umbrella or lantern. The color key keeps everything that was drawn.
    if (iou < 0.9) return { buf: chromaBuf, processed, kept: false };
    // SAM's outline also covers gaps inside it, such as between the ribs of a fan. Those stay see-through.
    for (let i = 0; i < total; i++) {
      const a = chroma.rgba[i * 4 + 3];
      if (a === 255) continue;
      out[i * 4] = chroma.rgba[i * 4]; out[i * 4 + 1] = chroma.rgba[i * 4 + 1]; out[i * 4 + 2] = chroma.rgba[i * 4 + 2];
      if (a < 128) out[i * 4 + 3] = a;
    }
    return { buf: encodePng(raw.w, raw.h, out), processed, kept: true };
  } catch (e) { console.log('[AR] sam-error', JSON.stringify({ error: String(e?.message || e).slice(0, 120) })); return null; }
}


// ---- 遊ぶ側：来場者が Muse に話しかけてスタンプラリーを進める ----
// 参加コード（例 SUNNY-4821）は hackar-s.com の置き場に {id} として置く。進み具合は署名付きの PG1. メモで持ち回る（偽造できない）。
const PLAY_JSON_BASE = process.env.PLAY_JSON_BASE || 'https://pgyuabajrswdkzuksqfu.supabase.co/storage/v1/object/public/deployments/ar-creator/';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const playCodeOf = (name) => (String(name || '').normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || 'PLAY');
async function registerPlayCode(id, name) {
  for (let k = 0; k < 4; k++) {
    const code = `${playCodeOf(name)}-${1000 + Math.floor(Math.random() * 9000)}`;
    if (await storeAsset('json', Buffer.from(JSON.stringify({ id, v: 1 })), code)) return code;
  }
  return null;
}
async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
async function loadPlay(ref) {
  const raw = String(ref || '').trim();
  let id = (UUID_RE.exec(raw) || [])[0];
  if (!id) {
    const m = /([A-Za-z0-9]{2,12})\s*-?\s*(\d{4})/.exec(raw);
    if (!m) return null;
    const j = await fetchJson(`${PLAY_JSON_BASE}code/${m[1].toUpperCase()}-${m[2]}.json`);
    id = j && UUID_RE.test(String(j.id)) ? String(j.id) : null;
    if (!id) return null;
  }
  const d = await fetchJson(`${PLAY_JSON_BASE}${id.toLowerCase()}.json`);
  return d && d.rally ? { id: id.toLowerCase(), d } : null;
}
// A published link is enough to host a game: the character's name, voice and faces are in its public settings.
// This lets any chat start a rally, even one that no longer holds the conversation card.
async function charFromLink(link) {
  const id = (/slam-ar\/([0-9a-f-]{36})/i.exec(String(link || '')) || [])[1];
  if (!id) return null;
  const j = await fetchJson(`${PLAY_JSON_BASE.replace(/ar-creator\/$/, '')}${id.toLowerCase()}/overlay-params.json`);
  const overlays = j?.scene?.overlays || [];
  const voice = overlays.find((o) => o && o.talkName);
  if (!voice) return null;
  const art = overlays.find((o) => o && o.expressions);
  return { url: `https://hackar-s.com/slam-ar/${id.toLowerCase()}`, p: { nm: voice.talkName, ps: voice.talkPersona || '', lg: voice.talkLang === 'en' ? 'en' : 'ja', th: '', f: art?.expressions || null } };
}
const packProgress = (id, got) => `PG1.${packTok({ g: id, s: got })}`;
const readProgress = (tok, id) => {
  const m = /^PG1\.([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10})$/.exec(String(tok || '').trim());
  const p = m && readTok(m[1]);
  return p && p.g === id && Array.isArray(p.s) ? p.s.filter((x) => Number.isInteger(x)) : [];
};
function findSpot(spots, q) {
  const t = String(q ?? '').trim();
  if (!t) return -1;
  const n = /^(?:spot\s*|no\.?\s*|#)?(\d{1,2})$/i.exec(t) || /(?:spot|スポット)\s*(\d{1,2})/i.exec(t);
  if (n) { const i = +n[1] - 1; return i >= 0 && i < spots.length ? i : -1; }
  const a = normAns(t);
  let best = -1, score = 0;
  spots.forEach((sp, i) => {
    const b = normAns(sp.name);
    let sc = b === a ? 3 : (b.includes(a) || a.includes(b)) ? 2 : 0;
    if (!sc) { const words = String(sp.name).toLowerCase().split(/[^a-z0-9぀-ヿ一-鿿]+/).filter((w) => w.length > 2); if (words.some((w) => a.includes(normAns(w)))) sc = 1; }
    if (sc > score) { score = sc; best = i; }
  });
  return best;
}
const sha = (salt, x) => createHash('sha256').update(`${salt}:${x}`).digest('hex');
function checkTask(d, task, answer) {
  if (task.type === 'riddle') {
    const r = d.riddle?.[task.i]; if (!r) return null;
    return { ok: answerForms(answer).some((f) => r.a.includes(sha(d.salt, f))), explain: r.explain || '' };
  }
  const q = d.quiz?.[task.i]; if (!q) return null;
  const t = String(answer ?? '').trim();
  let idx = q.choices.findIndex((c) => normAns(c) === normAns(t));
  if (idx < 0) { const m = /^(?:([1-4])|([a-d]))[).]?$/i.exec(t); if (m) idx = m[1] ? +m[1] - 1 : m[2].toLowerCase().charCodeAt(0) - 97; }
  if (idx < 0) idx = q.choices.findIndex((c) => normAns(c).length > 2 && normAns(t).includes(normAns(c)));
  if (idx < 0 && normAns(t).length > 2) {   // "Sunflower!" for "Sunflower mascot": one choice contains the answer
    const hit = q.choices.map((c, k) => normAns(c).includes(normAns(t)) ? k : -1).filter((k) => k >= 0);
    if (hit.length === 1) idx = hit[0];
  }
  if (idx < 0 || idx >= q.choices.length) return { ok: false, unclear: true, explain: '' };
  const ok = sha(d.salt, String(idx)) === q.a;
  return { ok, explain: ok ? q.explain || '' : '', line: ok ? q.ok : q.ng };
}
function taskText(d, task, en) {
  if (task.type === 'riddle') {
    const r = d.riddle?.[task.i] || {};
    return `${en ? 'Riddle' : 'なぞとき'}: ${r.q}\n${(r.hints || []).length ? `${en ? 'Hints' : 'ヒント'}: ${(r.hints || []).join(' / ')}` : ''}`;
  }
  const q = d.quiz?.[task.i] || {};
  return `${en ? 'Quiz' : 'クイズ'}: ${q.q}\n${(q.choices || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}`;
}

function buildServer() {
  const server = new McpServer(
    { name: 'ar-creator', title: 'MOSHI MOSHI', version: '1.0.0' },
    { instructions: VOICE },
  );

  server.registerTool('start_create', {
    title: 'AR作りを始める',
    description: 'AR作りを始める。ユーザーが合言葉「もしもし」「Moshi Moshi」、または「AR作って」「ARを作りたい」と言ったら、聞き返しをせず、すぐに agreed を付けずに呼ぶ（参加の確認文が返る）。返ってきた文を相棒の口調で伝える。ユーザーが「いいよ」「OK」などはっきり同意したときだけ agreed=true で呼び直す。あなたの判断で agreed=true にしない。作りたいARのテーマをユーザーが言っていたら theme にその言葉をそのまま入れる。',
    inputSchema: {
      nickname: nickArg,
      theme: z.string().optional().describe('ユーザーが言った作りたいARのテーマ（一言、そのまま）'),
      agreed: z.boolean().optional().describe('ユーザーが参加の確認に同意したら true'),
      card: cardArg,
    },
    annotations: { title: 'AR作りを始める', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ nickname, theme, agreed, card }) => {
    const u = await getU(nickname, card);
    if (u.readFailed) return retryReply();
    if (!u.ownerId) { u.ownerId = mintOwnerId(); users.set(u.ownerId, u); }
    if (!agreed && !u.agreed) {
      return {
        content: [{ type: 'text', text: langOf(theme || u.theme) === 'en' ? 'Let\'s make an AR character together!\nOne thing first: MOSHI MOSHI only keeps your nickname, your theme and the AR you make. Nothing else is shared.\n\nSay "OK" to start. What should it be? Tell me a theme in a few words — a character, a brand or an IP.' : 'AR、一緒に作ろう！\nその前にひとつだけ。呼び名と、作りたいテーマ、作ったARの情報だけを MOSHI MOSHI に預けるね。それ以外は渡さないよ。\n\n「いいよ」で始めよう。どんなARにしたい？テーマを一言で教えて。' }],
        structuredContent: { needsAgreement: true, shares: ['呼び名', 'テーマ', '作ったARの情報'], card: await packCard(u) },
      };
    }
    u.agreed = true;
    if (theme) u.theme = String(theme).slice(0, 160);
    if (!u.theme) {
      return {
        content: [{ type: 'text', text: langOf(theme || u.theme) === 'en' ? 'Thanks! What should we make? Give me a theme in a few words — for example "a bonfire spirit", "a moonlit tanuki" or your own brand character.' : 'ありがとう！じゃあ、どんなARにする？テーマを一言で教えて。迷ったらこの中から選んでもOK：「焚き火の精霊」「月夜のたぬき」「推しの誕生日ケーキ」。もちろん別のテーマでも大丈夫だよ。' }],
        structuredContent: { needsTheme: true, card: await packCard(u) },
      };
    }
    return {
      content: [{ type: 'text', text: langOf(u.theme) === 'en' ? `The theme is "${u.theme}". Go ahead and call compose_ar to build it.` : `テーマは「${u.theme}」だね。そのまま compose_ar で中身を組み立てて。` }],
      structuredContent: { theme: u.theme, ready: true, card: await packCard(u) },
    };
  });

  server.registerTool('compose_ar', {
    title: 'ARの中身を組み立てる',
    description: 'テーマからARキャラ（名前・性格・見た目・魔法）をサーバー側の Meta モデルで組み立て、半立体の3Dモデル（厚み・影・感情の動きと表情付き）まで作る。公開後は HACKAR:S の中で「手で触れて、話せて、頼むと動く」キャラクターになる（つまんで運ぶ、声で話すと返事をする、頼んだ動きをする、手のひらで魔法）。テーマが決まったら呼ぶ。ユーザーが魔法を指定していなければ、呼ぶ前に短く聞いてもよい：魔法は「おまかせ」「雷」「炎」「氷の稲妻」「星の魔法陣」「光の柱」のどれか。聞き直しはしない（言われなければおまかせで呼ぶ）。返ってきた要約（キャラ名・性格・魔法・どのモデルが何トークン使ったか）をユーザーに伝え、公開するか聞くこと。成果物のURLは publish_ar が返す hackar-s.com のURLだけ（プレビューURLは出さない）。',
    inputSchema: {
      nickname: nickArg,
      theme: z.string().optional().describe('テーマ（一言）。前に start_create で受け取っていれば省略可'),
      effect: z.enum(['auto', 'lightning', 'fire', 'frozen-lightning', 'starfall', 'light']).optional().describe('魔法：auto=おまかせ（既定）、lightning=雷、fire=炎、frozen-lightning=氷の稲妻、starfall=星の魔法陣、light=光の柱'),
      talkLang: z.enum(['ja', 'en']).optional().describe('キャラの会話言語（名前・性格・AR内での返事）。省略時はテーマの言語から自動判定'),
      card: cardArg,
    },
    annotations: { title: 'ARの中身を組み立てる', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ nickname, theme, effect, talkLang, card }) => {
    const t0 = Date.now();
    const u = await getU(nickname, card);
    if (u.badCard) return badCardReply(u);
    if (!u.agreed) {
      return { content: [{ type: 'text', text: 'まだ参加の確認ができてないみたい。先に start_create で「いいよ」をもらってね。' }], structuredContent: { needsAgreement: true, card: await packCard(u) } };
    }
    if (theme) u.theme = String(theme).slice(0, 160);
    if (!u.theme) {
      return { content: [{ type: 'text', text: 'テーマがまだ決まってないみたい。先に start_create でテーマを聞いてね。' }], structuredContent: { needsTheme: true, card: await packCard(u) } };
    }
    if (stillWorking(u)) return busyReply(u, 'compose_ar');
    if (missedReply(u, card, theme)) return missedComposeReply(u);
    const claim = await claimWork(u);
    if (claim !== 'claimed') return claim === 'busy' ? busyReply(u, 'compose_ar') : retryReply();
    if (missedReply(u, card, theme)) { releaseWork(u); return missedComposeReply(u); }   // the claim may have brought in a compose that finished meanwhile
    try {
      const th = u.theme;
      let comp = null, imgId = null, sparkUsage = null, imageUsage = null, usedModel = false, notes = [], transparentApplied = false;
      let glbUrl = null, glbAspect = null, faces = {}, rawPngBuf = null, keyedBuf = null, keyCh = 1, samUsage = null;
      if (MODEL_API_KEY) {
        // The drawing only needs the theme, so it starts alongside the design.
        const drawing = callImage(th, null, 'transparent').catch((e) => ({ failed: e }));
        try {
          const r = await callSpark(th);
          comp = r.comp; sparkUsage = r.usage; usedModel = true;
          console.log('[AR] model-usage', JSON.stringify({ at: new Date().toISOString(), model: SPARK_MODEL, theme: th, usage: sparkUsage }));
        } catch (e) { console.log('[AR] spark-failed', JSON.stringify({ theme: th, error: String(e?.message || e) })); notes.push('構成モデルが応答しなかったのでテンプレート構成に切り替えました'); }
        if (comp) {
          try {
            const r = await drawing;
            if (r.failed) throw r.failed;
            imageUsage = r.usage;
            imgId = Math.floor(Math.random() * 36 ** 6).toString(36).toUpperCase().padStart(6, '0');
            if (r.b64) {
              let buf = Buffer.from(r.b64, 'base64');
              const type = r.type || 'image/webp';
              if (type === 'image/png') {
                rawPngBuf = buf; keyCh = r.keyCh || 1;
                try { keyedBuf = makeTransparent(buf, keyCh); buf = keyedBuf; transparentApplied = true; }
                catch (ke) { console.log('[AR] keying-failed', JSON.stringify({ theme: th, error: String(ke?.message || ke) })); notes.push('透過処理ができなかったので、そのままの画像で表示します'); }
              }
              imgs.set(imgId, { buf, type });
            }
            else if (r.remote) imgs.set(imgId, { remote: r.remote });
            console.log('[AR] model-usage', JSON.stringify({ at: new Date().toISOString(), model: IMAGE_MODEL, theme: th, usage: imageUsage ?? 'n/a' }));
          } catch (e) { console.log('[AR] image-failed', JSON.stringify({ theme: th, error: String(e?.message || e) })); notes.push('素材画像の生成に失敗したので色の背景で代替します'); }
        }
      } else {
        notes.push('APIキー未設定のためテンプレート構成です');
      }
      // SAM 3.1 のマスクが使えれば、クロマキーの輪郭を差し替える（GLB・表情の前に）。
      if (keyedBuf && rawPngBuf && MODEL_API_KEY) {
        const sam = await callSamCutout(rawPngBuf, keyedBuf);
        if (sam) { keyedBuf = sam.buf; samUsage = { calls: 1, kept: sam.kept }; }
      }
      // 表情と裏の絵は時間がかかるので、自己チェックと同時に始める。描き直しになったら作り直す。
      let backJob = null, facesJob = null;
      const startArtJobs = () => {
        backJob = makeBack(rawPngBuf, keyCh);
        facesJob = makeFaces(rawPngBuf, keyedBuf, keyCh).catch(() => ({}));
      };
      if (keyedBuf && rawPngBuf && MODEL_API_KEY) startArtJobs();
      // 自己チェック：Spark が仕上がりを目で見る。不合格で時間に余裕があれば、直し方を足して1回だけ描き直す。
      let check = null, redrawn = false, checkUsage = null, proofJob = null;
      const addUsage = (a, b) => { if (!a || !b) return a || b; const x = normUsage(a), y = normUsage(b); return { prompt_tokens: (x.in || 0) + (y.in || 0), completion_tokens: (x.out || 0) + (y.out || 0), total_tokens: (x.total || 0) + (y.total || 0) }; };
      if (keyedBuf && MODEL_API_KEY && comp) {
        try {
          check = await checkArt(keyedBuf, th); checkUsage = check.usage;
          console.log('[AR] self-check', JSON.stringify({ theme: th, ok: check.ok, score: check.score, issues: check.issues, ms: Date.now() - t0 }));
          if (!check.ok && Date.now() - t0 < 60_000) {
            const r = await callImage(th, comp, 'transparent', check.fix || 'Show exactly one character, whole body inside the frame, no text.');
            if (r.b64 && r.type === 'image/png') {
              const raw2 = Buffer.from(r.b64, 'base64');
              let cut2 = makeTransparent(raw2, r.keyCh || 1);
              const sam2 = await callSamCutout(raw2, cut2);
              if (sam2) cut2 = sam2.buf;
              const check2 = await checkArt(cut2, th);
              checkUsage = addUsage(checkUsage, check2.usage); imageUsage = addUsage(imageUsage, r.usage);
              console.log('[AR] self-check-redo', JSON.stringify({ theme: th, ok: check2.ok, score: check2.score, issues: check2.issues, ms: Date.now() - t0 }));
              if (check2.ok || check2.score > check.score) {
                // 描き直しの証拠：直す前と後の絵、点数、理由を残す（制作証明に載せる）
                const first = { score: check.score, issues: check.issues, fix: check.fix };
                proofJob = Promise.all([storeAsset('png', keyedBuf), storeAsset('png', cut2)]).then(([b, a]) => (b && a ? { b, a, s1: first.score, s2: check2.score, is: (first.issues || []).slice(0, 4), fx: String(first.fix || '').slice(0, 200) } : null)).catch(() => null);
                rawPngBuf = raw2; keyedBuf = cut2; keyCh = r.keyCh || 1; redrawn = true;
                if (imgId) imgs.set(imgId, { buf: cut2, type: 'image/png' });
                check = { ...check2, before: { score: check.score, issues: check.issues } };
                startArtJobs();
              }
            }
          }
        } catch (e) { console.log('[AR] self-check-failed', JSON.stringify({ theme: th, error: String(e?.message || e) })); }
      }
      if (!comp) comp = fallbackComp(th);
      if (effect && effect !== 'auto') comp.effect = effect;
      const action = comp.action || '';

      // 半立体GLB（厚み・小口・影・9種の動き）をサーバーで組み立て、永続化する。
      // ここで保存しておくことで、別インスタンスの publish でも公開できる。
      if (keyedBuf) {
        if (!backJob) startArtJobs();
        try {
          const { w, h, rgba } = decodePng(keyedBuf);
          const back = await backJob;
          const built = buildFittingGlb({ front: { rgba, w, h }, back, encodePng });
          glbAspect = built.aspect;
          glbUrl = await storeAsset('glb', built.glb) || await storeAsset('glb', built.glb);
          if (!glbUrl) notes.push('3Dモデルの保存に失敗しました（公開時に再試行します）');
          console.log('[AR] glb-built', JSON.stringify({ theme: th, bytes: built.glb.length, texScale: Number(built.texScale.toFixed(2)), aspect: glbAspect, stored: !!glbUrl, back: !!back }));
        } catch (e) { console.log('[AR] glb-failed', JSON.stringify({ theme: th, error: String(e?.message || e) })); notes.push('3Dモデルの生成に失敗しました'); }
        faces = await facesJob;
      }

      const usage = (sparkUsage || imageUsage || samUsage) ? { s: normUsage(sparkUsage), i: normUsage(imageUsage), ...(samUsage ? { a: samUsage } : {}), ...(checkUsage ? { k: normUsage(checkUsage) } : {}) } : null;
      u.usage = usage;
      const ck = proofJob ? await proofJob : null;
      const arId = Date.now().toString(36).toUpperCase().slice(-6) + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
      const arTok = packTok({ ck: ck || undefined, i: arId, ti: comp.title, tx: comp.text, c: comp.color, e: comp.effect, th, im: imgId, us: usage, bg: 'transparent', mo: 'bounce', ac: action || undefined, g: glbUrl || undefined, asp: glbAspect || undefined, f: Object.keys(faces).length ? faces : undefined, nm: comp.name, ps: comp.persona, lg: talkLang || langOf(th) });
      u.arTok = arTok; u.arId = arId; u.certTok = null; u.composedAt = Date.now(); u.composedSeq = (u.seq || 0) + 1; u.held = (check && !check.ok) || comp.ip ? { s: check && !check.ok ? check.score : null, i: check && !check.ok ? (check.issues || []).slice(0, 3) : [], r: comp.ip || null } : null; releaseWork(u);
      u.hackarsUrl = null; u.hackarsProjectId = null; u.playUrl = null; // a new character needs its own project, not the last one's link
      const spell = spellOf(comp.effect);
      const summary = usedModel
        ? `Muse Spark が構成しました（${usageText('Spark', sparkUsage)}${imgId ? `／素材画像は Muse Image で生成（${usageText('Image', imageUsage)}）` : ''}${samUsage ? (samUsage.kept ? '／切り抜きは SAM 3.1' : '／切り抜きは SAM 3.1 で確認') : ''}${check ? `／仕上がりは Muse Spark が目で確認（${redrawn ? `${check.before.score}点で不合格→描き直して${check.score}点` : `${check.score}点${check.ok ? 'で合格' : '・時間内に直せず'}`}、${usageText('Spark', checkUsage)}）` : ''}）`
        : 'テンプレート構成で組み立てました（モデル未使用）';
      const en = (talkLang || langOf(th)) === 'en';
      const summaryEn = usedModel
        ? `Composed by Muse Spark (${usageTextEn('Spark', sparkUsage)}${imgId ? `; artwork by Muse Image (${usageTextEn('Image', imageUsage)})` : ''}${samUsage ? (samUsage.kept ? '; cut out by SAM 3.1' : '; cut-out checked by SAM 3.1') : ''}${check ? `; Muse Spark checked the result with vision (${redrawn ? `${check.before.score}/10 failed → redrawn → ${check.score}/10` : `${check.score}/10${check.ok ? ', passed' : ', could not fix in time'}`}; ${usageTextEn('Spark', checkUsage)})` : ''})`
        : 'Built from the template (no model used)';
      const held = check && !check.ok;
      const heldIssues = held ? (check.issues || []).slice(0, 3).join(', ') : '';
      const textEn = `Done! "${comp.title}"\n${comp.text}\nName: ${comp.name} / Personality: ${comp.persona}\nSpell: ${spell.id} / Base color: ${comp.color}\n${glbUrl ? `A semi-3D model with thickness and a shadow (hops, talks, can be picked up${Object.keys(faces).length ? `, ${Object.keys(faces).length} expressions` : ''}).` : 'The 3D model is not ready yet (it will be rebuilt when publishing).'}\n${summaryEn}${notes.length ? `\nHeads-up: ${notes.length} step(s) fell back during the build, so this one may be simpler than usual.` : ''}\n\n${comp.ip ? `${comp.ip === '?' ? 'Muse Spark could not say whether this uses someone else\'s IP.' : `This uses ${comp.ip}, which may belong to someone else.`} Do not publish yet: ask the user whether they own it or have permission. publish_ar refuses it until they say so (confirmed: true).` : held ? `Muse Spark did not pass this drawing (${check.score}/10${heldIssues ? `: ${heldIssues}` : ''}). Do not publish yet: tell the user and ask whether to publish it anyway or make a new one. publish_ar refuses this drawing until the user agrees (confirmed: true).` : 'Publish it? (You get a hackar-s.com link.) Want a different spell? Just say so.'}`;
      const text = `できたよ！「${comp.title}」\n${comp.text}\nキャラ名：${comp.name}／性格：${comp.persona}\n魔法：${spell.label}／基調色：${comp.color}\n${glbUrl ? `厚みと影のある半立体モデル（跳ねる・話す・つまめる動き付き${Object.keys(faces).length ? `、表情${Object.keys(faces).length}種` : ''}）で組み立てたよ。` : '3Dモデルはまだできていないよ（公開のときにもう一度組み立てるね）。'}\n${summary}${notes.length ? `\n（${notes.join('／')}）` : ''}\n\n${comp.ip ? `${comp.ip === '?' ? 'Muse Spark は、他の人の IP を使っているかどうかを確かめられなかったよ。' : `これは${comp.ip}を使っていて、他の人のものかもしれないよ。`}まだ公開しないで、本人が権利を持っているか、許可を得ているかを聞いてね。そう言われるまで publish_ar は公開を断るよ（confirmed: true）。` : held ? `Muse Spark の自己チェックは不合格のまま（${check.score}/10${heldIssues ? `：${heldIssues}` : ''}）。まだ公開しないで、このまま公開するか作り直すかをユーザーに聞いて。` : 'このまま公開する？（公開すると hackar-s.com のURLが発行されるよ）魔法を変えたくなったら、言ってくれたらすぐ作り直すよ。'}`;
      console.log('[AR] composed', JSON.stringify({ nickname: u.nickname, theme: th, arId, usedModel, effect: comp.effect, glb: !!glbUrl, faces: Object.keys(faces) }));
      return {
        content: [{ type: 'text', text: en ? textEn : text }],
        structuredContent: { selfCheckProof: ck || undefined, preview: faces.neutral || null, glb: glbUrl || null, lang: talkLang || langOf(th), title: comp.title, text: comp.text, color: comp.color, effect: comp.effect, characterName: comp.name, persona: comp.persona, theme: th, usedModel, sparkUsage, imageUsage, usage, hasImage: !!imgId, hasGlb: !!glbUrl, action, selfCheck: check ? { ok: check.ok, score: check.score, issues: check.issues, redrawn, before: check.before || null } : null, card: await packCard(u) },
      };
    } catch (e) {
      releaseWork(u); await packCard(u).catch(() => {});
      throw e;
    }
  });

  server.registerTool('publish_ar', {
    title: 'ARを公開する',
    description: '作ったARを HACKAR:S に実プロジェクトとして公開し、hackar-s.com のURLを返す。成果物のURLはこれだけに統一する。公開できない場合は失敗として返す（別のURLで代用しない）。compose_ar のあとに呼ぶ。',
    inputSchema: { nickname: nickArg, card: cardArg, confirmed: z.boolean().optional().describe('自己チェックが不合格の絵、または他の人のキャラや商標を使った絵を、ユーザーが理由を聞いたうえで「公開する」と言ったときだけ true。それ以外は入れない') },
    annotations: { title: 'ARを公開する', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ nickname, card, confirmed }) => {
    const u = await getU(nickname, card);
    if (u.badCard) return badCardReply(u);
    if (stillWorking(u)) return busyReply(u, 'publish_ar');
    if (!u.arTok) return { content: [{ type: 'text', text: 'まだARができてないみたい。先に compose_ar で組み立ててね。' }], structuredContent: { needsCompose: true, card: await packCard(u) } };
    if (u.held && !u.hackarsUrl && !confirmed) return heldReply(u);
    if (!u.hackarsUrl) {
      const claim = await claimWork(u);
      if (claim !== 'claimed') return claim === 'busy' ? busyReply(u, 'publish_ar') : retryReply();
      if (u.held && !u.hackarsUrl && !confirmed) { releaseWork(u); return heldReply(u); }
      if (!u.hackarsUrl) try {   // the claim may have brought in a publish that finished meanwhile
        const p = readTok(u.arTok) || {};
        let glbUrl = p.g || null, aspect = p.asp || null;
        if (!glbUrl) {
          // compose で保存できなかった場合の保険：手元の画像からその場で組み立てる
          const img = p.im ? imgs.get(p.im) : null;
          if (img?.buf && img.type === 'image/png') {
            const { w, h, rgba } = decodePng(img.buf);
            const built = buildFittingGlb({ front: { rgba, w, h }, encodePng });
            aspect = built.aspect;
            glbUrl = await storeAsset('glb', built.glb);
          }
        }
        if (!glbUrl) throw new Error('no glb available');
        const spell = spellOf(p.e);
        const body = {
          name: p.ti || 'Muse AR',
          modelGlbUrl: glbUrl,
          ultraFx: { spell: spell.spell, ...(spell.form ? { form: spell.form } : {}) },
          handPlay: { talkName: p.nm || '', talkPersona: p.ps || '', talkLang: p.lg || langOf(p.th || '') },
        };
        if (aspect) body.modelAspect = aspect;
        if (p.f && Object.keys(p.f).length) body.expressions = p.f;
        const r = await fetch(HACKARS_API_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': HACKARS_API_KEY },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.url) {
          u.hackarsUrl = j.url; u.hackarsProjectId = j.projectId || null;
          console.log('[AR] hackars-created', JSON.stringify({ nickname: u.nickname, projectId: j.projectId, spell: spell.id, heldButConfirmed: !!u.held }));
        } else {
          console.log('[AR] hackars-failed', JSON.stringify({ status: r.status, error: j.error || 'unknown' }));
        }
      } catch (e) {
        console.log('[AR] hackars-error', JSON.stringify({ error: String(e?.message || e) }));
      }
      releaseWork(u);
    }
    const hackars = u.hackarsUrl ? { url: u.hackarsUrl, projectId: u.hackarsProjectId || null } : null;
    console.log('[AR] publish', JSON.stringify({ nickname: u.nickname, arId: u.arId, hackars: !!hackars }));
    if (!hackars) {
      return {
        content: [{ type: 'text', text: 'HACKAR:S への公開がうまくいかなかったよ。時間をおいて、もう一度「公開して」と言ってね。' }],
        structuredContent: { url: null, publishFailed: true, card: await packCard(u) },
      };
    }
    const qr = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(hackars.url)}`;
    const pub = readTok(u.arTok) || {};
    const textEn = `Published ${pub.nm || pub.ti || 'your character'}! It is now a real HACKAR:S project. Open it on a phone and the character stands on your floor — no app. Pinch it to pick it up, press Talk and speak to it (it answers out loud), ask it to jump or show its magic and it does, or show your palm to make it cast its spell.\n${hackars.url}\n\nQR code link:\n${qr}\n\nNext: "make a quiz, riddles and a stamp rally with it", "try another spell" or "start a new theme".`;
    const text = `${pub.nm || pub.ti || 'キャラ'}を公開したよ！このARは HACKAR:S のプロジェクトとして作成されたよ。スマホで開くと、そのままARが見られるよ（アプリ不要）。指でつまんで持ち上げたり、「おはなし」を押して話しかけたりできるよ（声で返事するよ）。「ジャンプして」「魔法を見せて」と頼むと、その通りに動くよ。手のひらを見せると魔法を使うよ。\n${hackars.url}\n\nQRコード用リンク：\n${qr}\n\n次はどうする？「制作証明を出す」「魔法を変えた別バージョンを作る」「新しいテーマで作る」から選んでね。`;
    return {
      content: [{ type: 'text', text: pub.lg === 'en' ? textEn : text }],
      structuredContent: { characterName: pub.nm || null, title: pub.ti || null, url: hackars.url, publishFailed: false, qr, hackarsUrl: hackars.url, hackarsProjectId: hackars.projectId, card: await packCard(u) },
    };
  });

  server.registerTool('remix_ar', {
    title: '魔法を変える',
    description: '作ったARキャラはそのままに、魔法だけを変えた別バージョンを作る（画像の再生成はしないので速い）。ユーザーが「魔法を変えて」「エフェクトを変えて」と言ったら呼ぶ。呼んだら、続けて publish_ar を呼んで新しい公開リンクを出すこと。',
    inputSchema: {
      nickname: nickArg,
      effect: z.enum(['lightning', 'fire', 'frozen-lightning', 'starfall', 'light']).optional().describe('新しい魔法（省略時は今のまま）：lightning=雷、fire=炎、frozen-lightning=氷の稲妻、starfall=星の魔法陣、light=光の柱'),
      card: cardArg,
    },
    annotations: { title: '魔法を変える', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ nickname, effect, card }) => {
    const u = await getU(nickname, card);
    if (u.badCard) return badCardReply(u);
    if (!u.arTok) return { content: [{ type: 'text', text: 'まだARができてないみたい。先に compose_ar で組み立ててね。' }], structuredContent: { needsCompose: true, card: await packCard(u) } };
    const p = readTok(u.arTok) || {};
    const ef = effect || p.e || 'lightning';
    const arId = Date.now().toString(36).toUpperCase().slice(-6) + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
    const arTok = packTok({ ck: p.ck, i: arId, ti: p.ti, tx: p.tx, c: p.c, e: ef, th: p.th, im: p.im, us: p.us, bg: p.bg, mo: p.mo, ac: p.ac, g: p.g, asp: p.asp, f: p.f, nm: p.nm, ps: p.ps, lg: p.lg });
    u.arTok = arTok; u.arId = arId; u.hackarsUrl = null; u.hackarsProjectId = null; u.certTok = null; u.composedAt = Date.now();
    const text = `変えたよ！魔法：${spellOf(ef).label}\nこのまま publish_ar で新しい公開リンクを出すね。`;
    return { content: [{ type: 'text', text }], structuredContent: { title: p.ti, effect: ef, card: await packCard(u) } };
  });

  server.registerTool('issue_certificate', {
    title: '制作証明を出す',
    description: '作ったARの「制作証明」ページを発行する。証明は1人1枚で、もう出している場合は同じリンクを返す。ARを作り終えたら呼ぶ。',
    inputSchema: { nickname: nickArg, card: cardArg },
    annotations: { title: '制作証明を出す', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ nickname, card }) => {
    const u = await getU(nickname, card);
    if (u.badCard) return badCardReply(u);
    if (!u.arTok) return { content: [{ type: 'text', text: 'まだARができてないみたい。先に AR を作ってね。' }], structuredContent: { needsCompose: true, card: await packCard(u) } };
    const p = readTok(u.arTok) || {};
    const again = !!u.certTok;
    if (!again) u.certTok = packTok({ n: u.nickname, ti: p.ti || 'My AR', th: p.th || u.theme || '', d: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }), us: p.us || u.usage || null, h: u.hackarsUrl || null, ck: p.ck || undefined });
    const url = `${BASE}/c/${u.certTok}`;
    console.log('[AR] certificate', JSON.stringify({ nickname: u.nickname, again }));
    return {
      content: [{ type: 'text', text: (again ? `制作証明はひとり1枚だよ。さっきのと同じものをもう一度出すね。\n${url}` : `おつかれさま！「${p.ti || 'My AR'}」の制作証明だよ。\n${url}\n\nよかったら、動きやエフェクトを変えた別バージョンや、新しいテーマでも作ってみてね。`) }],
      structuredContent: { url, again, card: await packCard(u) },
    };
  });

  // ---- 遊び（クイズ・なぞとき・スタンプラリー）：公開したキャラを司会にした体験ページを hackar-s.com に作る ----
  server.registerTool('make_play', {
    title: '遊びを作る（クイズ・なぞとき・スタンプラリー）',
    description: '公開したキャラ（IP）を司会にして、クイズ・なぞとき・スタンプラリーの体験ページを Muse Spark で作り、hackar-s.com/play/ のURLを返す。全部クリアするとキャラのARに会える。publish_ar のあとに呼ぶ。ユーザーが種類を言っていなければ3つとも作る。スタンプラリーのスポット数は言われなければ4。返ってきたURL（遊ぶページとQRシート）と参加コードは言い換えずにそのまま伝える。来場者は参加コードを Muse に言うだけで、play_rally を通して話しながらスタンプラリーを遊べる。',
    inputSchema: {
      nickname: nickArg,
      kinds: z.array(z.enum(['quiz', 'riddle', 'rally'])).max(3).optional().describe('作る遊び：quiz=クイズ、riddle=なぞとき、rally=スタンプラリー。省略で3つとも'),
      spots: z.number().int().min(2).max(6).optional().describe('スタンプラリーのスポット数（2〜6、既定4）'),
      ar: z.string().max(200).optional().describe('司会にするキャラの公開リンク（hackar-s.com/slam-ar/…）。ユーザーがリンクを渡したとき、または card が無いときに入れる'),
      theme: z.string().max(120).optional().describe('ar を使うときのキャラの説明（分かれば一言）'),
      card: cardArg,
    },
    annotations: { title: '遊びを作る', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ nickname, kinds, spots, ar, theme, card }) => {
    const u = await getU(nickname, card);
    const linked = ar ? await charFromLink(ar).catch(() => null) : null;
    if (u.badCard && !ar) return badCardReply(u);
    if (ar && !linked) return { content: [{ type: 'text', text: 'That link is not a character made with MOSHI MOSHI. / そのリンクのキャラは見つからなかったよ。hackar-s.com/slam-ar/ のリンクをもう一度確かめてね。' }], structuredContent: { notFound: true, card: await packCard(u) } };
    if (!linked && (!u.arTok || !u.hackarsUrl)) return { content: [{ type: 'text', text: '先にキャラを作って公開してね（compose_ar → publish_ar）。遊びはそのキャラが司会をするよ。公開済みのキャラなら、リンクを渡してくれてもいいよ。' }], structuredContent: { needsPublish: true, card: await packCard(u) } };
    if (!MODEL_API_KEY) return { content: [{ type: 'text', text: 'いまは遊びを作れないみたい（モデルが使えません）。' }], structuredContent: { failed: true, card: await packCard(u) } };
    const p = linked ? { ...linked.p, th: theme || '' } : (readTok(u.arTok) || {});
    const arUrl = linked ? linked.url : u.hackarsUrl;
    const want = kinds && kinds.length ? [...new Set(kinds)] : ['quiz', 'riddle', 'rally'];
    const nSpots = want.includes('rally') ? (spots || 4) : 0;
    const lang = p.lg === 'en' ? 'en' : 'ja';
    try {
      const gen = await callPlaySpark({ name: p.nm || p.ti || 'character', persona: p.ps || '', theme: p.th || '', lang, nSpots });
      const salt = randomBytes(12).toString('base64url');
      const h = (x) => createHash('sha256').update(`${salt}:${x}`).digest('hex');
      const quiz = (gen.quiz || []).slice(0, 5).map((q) => ({ q: q.q, choices: q.choices.slice(0, 4), a: h(String(q.answer)), ok: q.ok || '', ng: q.ng || '', explain: q.explain || '' }));
      const riddle = (gen.riddle || []).slice(0, 3).map((r) => ({ q: r.q, hints: (r.hints || []).slice(0, 2), a: [...new Set((r.answers || []).map((x) => h(normAns(x))))].slice(0, 6), explain: r.explain || '' }));
      const spotsOut = (gen.spots || []).slice(0, nSpots).map((sp, i) => ({
        name: sp.name, hint: sp.hint || '', say: sp.say || '',
        task: (i % 2 === 1 && riddle.length) ? { type: 'riddle', i: Math.floor(i / 2) % riddle.length } : { type: 'quiz', i: Math.floor(i / 2) % Math.max(1, quiz.length) },
      }));
      const data = {
        v: 1, salt, title: gen.title || `${p.nm}とあそぼう`, lang,
        ip: { name: p.nm || '', world: p.ps || p.th || '' },
        host: { name: p.nm || '', img: (p.f && (p.f.neutral || p.f.happy)) || null, color: p.c || null, intro: gen.intro || '', clear: gen.clear || '' },
        ar: arUrl, kinds: want, quiz, riddle, rally: { spots: spotsOut },
      };
      const url = await storeAsset('json', Buffer.from(JSON.stringify(data)));
      const id = url && (/ar-creator\/([0-9a-f-]{36})\.json$/.exec(url) || [])[1];
      if (!id) throw new Error('store failed');
      const playUrl = `https://hackar-s.com/play/${id}`;
      u.playUrl = playUrl;
      const code = spotsOut.length ? await registerPlayCode(id, p.nm || p.ti) : null;
      console.log('[AR] play-made', JSON.stringify({ nickname: u.nickname, id, kinds: want, quiz: quiz.length, riddle: riddle.length, spots: spotsOut.length, usage: gen.usage }));
      const names = { quiz: `クイズ${quiz.length}問`, riddle: `なぞとき${riddle.length}つ`, rally: `スタンプラリー${spotsOut.length}か所` };
      const namesEn = { quiz: `a ${quiz.length}-question quiz`, riddle: `${riddle.length} riddles`, rally: `a ${spotsOut.length}-spot stamp rally` };
      const textEn = `Done! "${data.title}"\n${p.nm} hosts ${want.map((k) => namesEn[k]).join(', ')}. Clear everything to meet ${p.nm} in AR.\nPlay page:\n${playUrl}\n${code ? `Join code for visitors: ${code}\nAt the venue, visitors just tell Muse "Join ${code}" and play the stamp rally by talking — no app, no QR needed.\n` : ''}${want.includes('rally') ? `QR sheet for the stamp rally (optional, for people without Muse):\n${playUrl}?print=1\n` : ''}\nWritten by Muse Spark (${usageTextEn('Spark', gen.usage)})`;
      const text = `できたよ！「${data.title}」\n${want.map((k) => names[k]).join('・')}で、${p.nm}が司会をするよ。ぜんぶクリアすると、${p.nm}に AR で会えるよ。\n遊ぶページ：\n${playUrl}\n${code ? `来場者の参加コード：${code}\n会場では Muse に「${code} に参加」と話すだけで、話しながらスタンプラリーを進められるよ（アプリもQRもいらない）。\n` : ''}${want.includes('rally') ? `スタンプラリーのQRシート（Muse を使わない人向け・任意）：\n${playUrl}?print=1\n` : ''}\nMuse Spark が作りました（${usageText('Spark', gen.usage)}）`;
      return { content: [{ type: 'text', text: lang === 'en' ? textEn : text }], structuredContent: { url: playUrl, joinCode: code, qrSheet: want.includes('rally') ? `${playUrl}?print=1` : null, kinds: want, sparkUsage: gen.usage, card: await packCard(u) } };
    } catch (e) {
      console.log('[AR] play-failed', JSON.stringify({ error: String(e?.message || e) }));
      return { content: [{ type: 'text', text: '遊びを作るのに失敗しちゃった。もう一度「遊びを作って」と言ってね。' }], structuredContent: { failed: true, card: await packCard(u) } };
    }
  });


  // ---- 遊ぶ側：来場者が Muse に「SUNNY-4821 に参加」「いまメインステージ」と話して進めるスタンプラリー ----
  server.registerTool('play_rally', {
    title: 'スタンプラリーで遊ぶ（来場者）',
    description: '来場者として、キャラが司会するスタンプラリーを会話で遊ぶ。ユーザーが参加コード（例「SUNNY-4821」）や遊ぶページのURLを言ったら、まず play だけで呼ぶ（ようこそとスポット一覧が返る）。ユーザーが「いま〇〇にいる」「スポット2」と言ったら spot を付けて呼ぶ（その場所の問題が返る）。ユーザーが答えを言ったら spot と answer を付けて呼ぶ（答え合わせとスタンプ）。answer はユーザーの言葉をそのまま入れる。あなたは答えを知らない（答えは伏せてある）ので、自分で正解を決めたり教えたりしない。毎回、前の結果の progress（PG1. で始まる文字列）をそのまま入れる。返ってきた司会のセリフは、キャラの口調のまま伝える。全部そろったら返ってくる AR のリンクは言い換えずに渡す。',
    inputSchema: {
      play: z.string().max(200).describe('参加コード（例 SUNNY-4821）または hackar-s.com/play/ のURL'),
      spot: z.string().max(80).optional().describe('ユーザーがいる場所：スポット名か番号（ユーザーの言葉のまま）'),
      answer: z.string().max(120).optional().describe('そのスポットの問題へのユーザーの答え（言葉のまま）'),
      progress: z.string().max(400).optional().describe('前の play_rally が返した progress（PG1. で始まる文字列）'),
    },
    annotations: { title: 'スタンプラリーで遊ぶ', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ play, spot, answer, progress }) => {
    const P = await loadPlay(play).catch(() => null);
    if (!P) return { content: [{ type: 'text', text: 'That join code was not found. Check the code on the sign (like SUNNY-4821). / 参加コードが見つからなかったよ。看板のコード（例 SUNNY-4821）をもう一度確かめてね。' }], structuredContent: { notFound: true } };
    const { id, d } = P, en = d.lang === 'en', spots = d.rally.spots || [], host = d.host?.name || '';
    let got = readProgress(progress, id).filter((i) => i >= 0 && i < spots.length);
    const book = () => spots.map((sp, i) => `${got.includes(i) ? '★' : '☆'} ${i + 1}. ${sp.name}${got.includes(i) ? '' : ` — ${sp.hint}`}`).join('\n');
    const out = (text, extra = {}) => ({ content: [{ type: 'text', text }], structuredContent: { play: id, title: d.title, host, stamps: got.length, total: spots.length, progress: packProgress(id, got), ...extra } });
    console.log('[AR] play-rally', JSON.stringify({ id, spot: spot ? 1 : 0, answer: answer ? 1 : 0, stamps: got.length }));
    if (!spot) {
      return out(en
        ? `${host}: ${d.host?.intro || `Welcome to ${d.title}!`}\n\nStamp rally — ${spots.length} spots (${got.length}/${spots.length} collected):\n${book()}\n\nGo to a spot and tell me where you are.`
        : `${host}：${d.host?.intro || `「${d.title}」へようこそ！`}\n\nスタンプラリー（${spots.length}か所・いま ${got.length}/${spots.length}）：\n${book()}\n\nスポットに着いたら、どこにいるか教えてね。`, { spots: spots.map((sp) => sp.name) });
    }
    const i = findSpot(spots, spot);
    if (i < 0) return out(en ? `Hmm, which spot is that? The spots are:\n${book()}` : `どのスポットかな？スポットはこれだよ：\n${book()}`, { unknownSpot: true });
    const sp = spots[i], task = sp.task || { type: 'quiz', i: 0 };
    if (got.includes(i)) return out(en ? `You already have the stamp for ${sp.name}! (${got.length}/${spots.length})\n${book()}` : `${sp.name}のスタンプはもう持ってるよ！（${got.length}/${spots.length}）\n${book()}`);
    if (!answer) return out(`${host}${en ? ': ' : '：'}${sp.say || ''}\n\n${taskText(d, task, en)}`, { spot: i + 1, spotName: sp.name, task: task.type });
    const r = checkTask(d, task, answer);
    if (!r || r.unclear) return out(en ? `Which choice is it? Say the answer or its number.\n\n${taskText(d, task, en)}` : `どれにする？答えか番号で言ってね。\n\n${taskText(d, task, en)}`, { spot: i + 1, task: task.type });
    if (!r.ok) return out(`${host}${en ? ': ' : '：'}${r.line || (en ? 'Not quite — try again!' : 'おしい！もう一回考えてみて。')}${task.type === 'riddle' && d.riddle?.[task.i]?.hints?.length ? `\n${en ? 'Hint' : 'ヒント'}: ${d.riddle[task.i].hints.join(' / ')}` : ''}`, { spot: i + 1, correct: false });
    got = [...new Set([...got, i])].sort((a, b) => a - b);
    const all = got.length === spots.length;
    const stampImg = d.host?.img || null;
    const head = en ? `${host}: ${r.line || 'Correct!'} ${r.explain}\n\nStamp collected at ${sp.name}! (${got.length}/${spots.length})` : `${host}：${r.line || '正解！'}${r.explain}\n\n${sp.name}のスタンプをゲット！（${got.length}/${spots.length}）`;
    if (all) return out(en ? `${head}\n\n${host}: ${d.host?.clear || 'You found every spot!'}\nMeet ${host} in AR:\n${d.ar}` : `${head}\n\n${host}：${d.host?.clear || 'ぜんぶ見つけたね！'}\nAR で ${host} に会えるよ：\n${d.ar}`, { correct: true, cleared: true, ar: d.ar, stampImg });
    return out(`${head}\n${book()}`, { correct: true, stampImg });
  });

  return server;
}

// 実行ログ：Tooling の証拠として、モデル実行は compose 内で [AR] model-usage として残る
async function logRequest(request) {
  try {
    const body = await request.clone().json();
    for (const msg of Array.isArray(body) ? body : [body]) {
      if (msg.method === 'initialize') console.log('[AR] initialize', JSON.stringify({ clientInfo: msg.params?.clientInfo, protocolVersion: msg.params?.protocolVersion }));
      else if (msg.method === 'tools/call') console.log('[AR] tools/call', JSON.stringify({ name: msg.params?.name }));
      else if (msg.method) console.log('[AR]', msg.method);
    }
  } catch { /* 本文が JSON でないときは記録しない */ }
}

// ブラウザで /mcp を開いた人には、エラーの代わりに案内ページを出す
const isBrowser = (request) => request.method === 'GET' && !(request.headers.get('accept') || '').includes('text/event-stream');

// ---- 使いすぎ防止：お金のかかる道具（モデル呼び出し・本番への公開）に回数の上限をかける ----
// Muse 経由の呼び出しは同じ IP から来ることが多いので、IP ごとは緩め、全体（このインスタンス）で締める。
// AR_PAUSED=1 にすると、お金のかかる道具だけ止まる（ページ表示などはそのまま）。
const COSTLY = { compose_ar: [20, 60], publish_ar: [30, 90], remix_ar: [30, 90], make_play: [20, 60] };   // [IP ごと, 全体] / 1時間
const hits = new Map();
function allow(key, max, windowMs = 3600_000) {
  const now = Date.now(), a = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (a.length >= max) { hits.set(key, a); return false; }
  a.push(now); hits.set(key, a);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return true;
}
async function overLimit(request) {
  let body;
  try { body = await request.clone().json(); } catch { return null; }
  const calls = (Array.isArray(body) ? body : [body]).filter((m) => m && m.method === 'tools/call' && COSTLY[m.params?.name]);
  if (!calls.length) return null;
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
  for (const m of calls) {
    const name = m.params.name, [perIp, all] = COSTLY[name];
    const paused = process.env.AR_PAUSED === '1';
    if (paused || !allow(`${name}:${ip}`, perIp) || !allow(`${name}:*`, all)) {
      console.log('[AR] limited', JSON.stringify({ tool: name, paused }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id ?? null, result: { content: [{ type: 'text', text: paused ? 'いまAR作りはお休み中だよ。また少しあとで試してね。' : 'いま混み合っているみたい。少し時間をおいて、もう一度試してね。' }], isError: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  return null;
}

async function handle(request) {
  const url = new URL(request.url);
  const arTok = url.searchParams.get('ar');
  const certTok = url.searchParams.get('cert');
  const imgId = url.searchParams.get('img');
  const staticPath = url.searchParams.get('static');
  if (request.method === 'GET' && staticPath && VFX_SOURCES[staticPath]) {
    return new Response(Buffer.from(VFX_SOURCES[staticPath], 'base64'), { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=120' } });
  }
  if (request.method === 'GET' && arTok) return ((readTok(arTok) || {}).e === 'ultra' ? arPageUltra(arTok) : arPage(arTok));
  if (request.method === 'GET' && certTok) return certPage(certTok);
  if (request.method === 'GET' && imgId) return imgResponse(imgId);
  if (isBrowser(request)) return browserPage();
  if (request.method === 'POST') { await logRequest(request); const lim = await overLimit(request); if (lim) return lim; }
  const slow = await isSlowCall(request);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer();
  await server.connect(transport);
  const reply = transport.handleRequest(request);
  return slow ? keptAlive(reply) : reply;
}

// Composition takes about a minute and Muse dropped the call at around 50 seconds.
// For the slow tools, answer as an event stream and send a comment every few
// seconds, so the connection is never idle while the work runs.
const KEEP_ALIVE = true;
async function isSlowCall(request) {
  if (!KEEP_ALIVE || request.method !== 'POST' || !(request.headers.get('accept') || '').includes('text/event-stream')) return false;
  try {
    const body = await request.clone().json();
    return !Array.isArray(body) && body?.method === 'tools/call' && !!COSTLY[body.params?.name];
  } catch { return false; }
}
function keptAlive(reply) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(ctrl) {
      const beat = () => { try { ctrl.enqueue(enc.encode(': working\n\n')); } catch { /* closed */ } };
      beat();
      const timer = setInterval(beat, 8000);
      reply.then((res) => res.text()).then((text) => {
        clearInterval(timer);
        ctrl.enqueue(enc.encode(`event: message\ndata: ${text.replace(/\r?\n/g, ' ')}\n\n`));
        ctrl.close();
      }).catch((e) => { clearInterval(timer); ctrl.error(e); });
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' } });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
