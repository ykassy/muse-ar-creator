// AR Creator — 「Talk to Muse, unlock AR」
// Muse の会話からコネクターがアクションし、Meta Model API で AR の中身を組み立てて、
// アプリレス WebAR として公開する MCP サーバー（Streamable HTTP・ステートレス）。
// 構造は 以前の自社コネクター試作と同じ流儀：単一ファイル＋署名付き「カード」メモで状態を持つ。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createHmac } from 'node:crypto';
import { z } from 'zod';

const BASE = process.env.PUBLIC_BASE_URL || 'https://hackathon-ar-creator.vercel.app';
const SECRET = process.env.CARD_SECRET || 'removed';
const MODEL_API_KEY = process.env.MODEL_API_KEY || '';
const API_BASE = 'https://api.meta.ai/v1';
const SPARK_MODEL = 'muse-spark-1.3';
const IMAGE_MODEL = 'muse-image-1.0';

const EFFECTS = ['flame', 'ice', 'lightning', 'petal'];

// ---- 署名付きトークン（以前の自社試作と同じ仕組みを新規実装） ----
// カード：会話の状態（同意・テーマ・AR・証明）を Muse 経由で持ち回るメモ。
// AR／証明トークン：表示に必要な最小データを署名付きで URL 自体に埋め込む（ページは再起動後も開ける）。
const sign = (s) => createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 10);
const packTok = (obj) => { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${b}.${sign(b)}`; };
const readTok = (tok) => {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{10})$/.exec((tok || '').trim());
  if (!m || sign(m[1]) !== m[2]) return null;
  try { return JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { return null; }
};
const packCard = (u) => `HC1.${packTok({ n: u.nickname, a: u.agreed ? 1 : 0, t: u.theme || null, ar: u.arTok || null, c: u.certTok || null, us: u.usage || null })}`;
const readCard = (card) => {
  const m = /^HC1\.([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10})$/.exec((card || '').trim());
  return m ? readTok(m[1]) : null;
};

// ---- 状態：サーバーメモリ＋カードの2本立て（メモリが消えたらカードを正にする） ----
const users = new Map(); // nickname -> { nickname, agreed, theme, arTok, arId, certTok, usage }
// 生成画像（WebP 約430KB）は URL トークンに入らないので、短いIDでメモリ保持し /img/<id> で配信する。
// メモリが落ちたら画像は 404 になり、ARページはエフェクト＋テキストだけで成立させる（graceful degradation）。
const imgs = new Map();  // imgId -> { buf: Buffer, type } | { remote: url }
const keyOf = (nickname) => (nickname || 'guest').trim().toLowerCase() || 'guest';
const getU = (nickname, card) => {
  const k = keyOf(nickname);
  if (!users.has(k)) users.set(k, { nickname: k, agreed: false, theme: null, arTok: null, arId: null, certTok: null, usage: null });
  const u = users.get(k), c = readCard(card);
  if (c) {
    if (c.a) u.agreed = true;
    if (c.t && !u.theme) u.theme = c.t;
    if (c.ar && !u.arTok) { u.arTok = c.ar; const p = readTok(c.ar); if (p) u.arId = p.i; }
    if (c.c && !u.certTok) u.certTok = c.c;
    if (c.us && !u.usage) u.usage = c.us;
  }
  return u;
};
const memo = (u) => ({ type: 'text', text: `（相棒へのメモ：ユーザーには見せないで。次に AR Creator の道具を呼ぶときは card に「${packCard(u)}」を入れる）` });
const cardArg = z.string().optional().describe('前の返事の「相棒へのメモ」にある進み具合メモ（HC1. で始まる文字）。あればそのまま入れる');
const nickArg = z.string().optional().describe('ユーザーの呼び名（毎回同じものを入れる）');

// ---- Meta Model API ----
async function fetchSpark(theme) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      model: SPARK_MODEL,
      temperature: 0.8,
      // muse-spark-1.3 は推論モデル：推論トークンで本文が食い尽くされないよう上限を広く取る
      max_tokens: 2500,
      messages: [
        { role: 'system', content: 'You are an AR experience composer for an app-less WebAR product. Reply with ONE JSON object only, no markdown, no code fences, no commentary.' },
        { role: 'user', content: `Compose a small AR overlay for the theme: "${theme}".\nReturn JSON with exactly these keys:\n- "title": a short English title, at most 5 words\n- "text": one English line shown over the camera view, at most 90 characters\n- "color": one base color as #RRGGBB that matches the mood\n- "effect": one of "flame", "ice", "lightning", "petal" — pick the particle effect that best matches the theme` },
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

async function callImage(theme, comp) {
  const res = await fetch(`${API_BASE}/images/generations`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(40_000),
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: `A single charming mascot-like character illustration for an AR overlay, theme: "${theme}" (${comp.title}). Flat vector style, bold shapes, transparent-looking clean background in the base color ${comp.color}, no text, no letters, centered, full body, playful.`,
      size: '1024x1024',
    }),
  });
  if (!res.ok) throw new Error(`image http ${res.status}`);
  const data = await res.json();
  const d = data?.data?.[0] || {};
  // 返却は URL ではなく data[0].b64_json（WebP）。バイト列は呼び出し側で /img/<id> 配信に回す。
  if (d.b64_json) return { b64: d.b64_json, remote: null, usage: data?.usage || null };
  if (d.url) return { b64: null, remote: d.url, usage: data?.usage || null };
  throw new Error('image returned no data');
}

// Spark が返した構成を安全な値に寄せる
function normalizeComp(c, theme) {
  const color = /^#[0-9a-fA-F]{6}$/.test(c?.color || '') ? c.color : fallbackComp(theme).color;
  let effect = EFFECTS.includes(c?.effect) ? c.effect : null;
  if (!effect) { // 言い換え・表記ゆれを吸収する
    const s = String(c?.effect || '').toLowerCase();
    effect = EFFECTS.find((e) => s.includes(e)) || ({ fire: 'flame', snow: 'ice', thunder: 'lightning', flower: 'petal', sakura: 'petal' })[Object.keys({ fire: 1, snow: 1, thunder: 1, flower: 1, sakura: 1 }).find((k) => s.includes(k))] || fallbackComp(theme).effect;
  }
  return {
    title: String(c?.title || '').slice(0, 60) || fallbackComp(theme).title,
    text: String(c?.text || '').slice(0, 120) || fallbackComp(theme).text,
    color, effect,
  };
}

// 生成に失敗しても AR は必ず立てるためのテンプレート構成（テーマのハッシュで決定的に選ぶ）
const PALETTES = [
  { color: '#FF7A1A', effect: 'flame' },
  { color: '#39B5FF', effect: 'ice' },
  { color: '#7A5CFF', effect: 'lightning' },
  { color: '#FF8FB3', effect: 'petal' },
];
function fallbackComp(theme) {
  const t = String(theme || '');
  const kw = [/(炎|火|燃|ドラゴン|fire|flame|dragon)/i, /(雪|氷|冬|snow|ice|winter)/i, /(雷|電|光|lightning|thunder|spark)/i, /(花|桜|春|petal|flower|sakura)/i];
  const ki = kw.findIndex((re) => re.test(t));
  let h = 0; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const p = PALETTES[ki >= 0 ? ki : h % PALETTES.length];
  return { title: `${theme} AR`, text: `Welcome to the world of ${theme}.`, color: p.color, effect: p.effect };
}

// chat（prompt/completion_tokens）と image（input/output_tokens）で形が違う usage を共通形に寄せる
const normUsage = (u) => {
  if (!u) return null;
  const inp = u.prompt_tokens ?? u.input_tokens ?? null;
  const out = u.completion_tokens ?? u.output_tokens ?? null;
  const total = u.total_tokens ?? (((inp ?? 0) + (out ?? 0)) || null);
  return { in: inp, out, total };
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
  const cfg = { title: p.ti, text: p.tx, color: p.c, effect: p.e, theme: p.th, image: p.im ? `/img/${p.im}` : null };
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(p.ti)} — AR Creator</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0b0b10;font-family:-apple-system,'Hiragino Sans',sans-serif;color:#fff}
#cam{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;background:linear-gradient(160deg,${esc(p.c)},#14141d 75%)}
#fx{position:fixed;inset:0}
.hud{position:fixed;left:0;right:0;text-align:center;pointer-events:none;padding:0 18px;box-sizing:border-box}
#ttl{top:calc(18px + env(safe-area-inset-top));font-size:30px;font-weight:900;letter-spacing:.02em;text-shadow:0 2px 18px rgba(0,0,0,.55)}
#sub{top:calc(64px + env(safe-area-inset-top));font-size:14px;opacity:.92;text-shadow:0 1px 10px rgba(0,0,0,.6)}
#theme{bottom:calc(20px + env(safe-area-inset-bottom));font-size:13px;opacity:.85;text-shadow:0 1px 8px rgba(0,0,0,.6)}
#card{position:fixed;left:50%;bottom:12%;transform:translateX(-50%);width:min(46vw,220px);border-radius:20px;overflow:hidden;box-shadow:0 14px 44px rgba(0,0,0,.5);animation:float 4.5s ease-in-out infinite;background:${esc(p.c)}}
#card img{display:block;width:100%;height:auto}
@keyframes float{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-12px)}}
#note{position:fixed;left:50%;bottom:calc(64px + env(safe-area-inset-bottom));transform:translateX(-50%);font-size:12px;background:rgba(0,0,0,.45);padding:6px 12px;border-radius:999px;display:none}
#start{position:fixed;inset:0;display:grid;place-items:center;background:rgba(8,8,14,.55);backdrop-filter:blur(3px)}
#start button{border:0;border-radius:999px;padding:16px 34px;font-size:17px;font-weight:800;background:${esc(p.c)};color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.45)}
</style></head><body>
<video id="cam" autoplay playsinline muted></video>
<canvas id="fx"></canvas>
<div class="hud" id="ttl">${esc(p.ti)}</div>
<div class="hud" id="sub">${esc(p.tx)}</div>
${cfg.image ? `<div id="card"><img src="${esc(cfg.image)}" alt="" onerror="this.closest('#card').style.display='none'"></div>` : ''}
<div class="hud" id="theme">theme: ${esc(p.th)} ・ Talk to Muse, unlock AR</div>
<div id="note"></div>
<div id="start"><button id="go">カメラで見る</button></div>
<script src="https://unpkg.com/three@0.152.2/build/three.min.js"></script>
<script>
var CFG = ${jsJson(cfg)};
// ---- three.js パーティクル（Ultra Elements の考え方を最小実装に抽出：1エフェクト=1パラメータセット） ----
var PARAMS = {
  flame:     { n: 260, dir: 'up',    speed: [0.6, 1.8], sway: 0.15, size: 26, ramp: ['#fff3b0', CFG.color, '#e62e00'], spawn: 'bottom' },
  ice:       { n: 200, dir: 'down',  speed: [0.15, 0.5], sway: 0.35, size: 15, ramp: ['#ffffff', '#bfefff', '#7fd4ff'], spawn: 'top' },
  lightning: { n: 170, dir: 'burst', speed: [1.2, 3.2], sway: 0.05, size: 13, ramp: ['#ffffff', '#cfe8ff', '#5aa2ff'], spawn: 'center' },
  petal:     { n: 140, dir: 'down',  speed: [0.2, 0.55], sway: 0.9, size: 22, ramp: ['#ffffff', '#ffc2d6', '#ff8fb3'], spawn: 'top' }
};
var P = PARAMS[CFG.effect] || PARAMS.petal;
function startFx() {
  if (!window.THREE) return; // three.js が読めなければ映像＋画像だけでも体験は成立させる
  var canvas = document.getElementById('fx');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  var scene = new THREE.Scene();
  var cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); cam.position.z = 5;
  function resize() { renderer.setSize(innerWidth, innerHeight); }
  resize(); addEventListener('resize', resize);
  var N = P.n, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), life = new Float32Array(N), vel = new Float32Array(N * 2), seed = new Float32Array(N);
  var ramp = P.ramp.map(function (c) { return new THREE.Color(c); });
  function respawn(i, randomY) {
    var x = (Math.random() * 2 - 1) * 1.05, y;
    if (P.spawn === 'bottom') y = -1.05; else if (P.spawn === 'top') y = 1.05; else y = (Math.random() * 2 - 1) * 0.4;
    if (randomY) y = Math.random() * 2 - 1;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = 0;
    life[i] = Math.random() * 0.4 + 0.6;
    var s = P.speed[0] + Math.random() * (P.speed[1] - P.speed[0]);
    if (P.dir === 'up') { vel[i * 2] = (Math.random() - 0.5) * 0.1; vel[i * 2 + 1] = s * 0.55; }
    else if (P.dir === 'down') { vel[i * 2] = (Math.random() - 0.5) * 0.08; vel[i * 2 + 1] = -s * 0.4; }
    else { var a = Math.random() * Math.PI * 2; vel[i * 2] = Math.cos(a) * s * 0.5; vel[i * 2 + 1] = Math.sin(a) * s * 0.5; life[i] = Math.random() * 0.25 + 0.15; }
    seed[i] = Math.random() * 100;
    var c = ramp[Math.floor(Math.random() * ramp.length)];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  for (var i = 0; i < N; i++) respawn(i, true);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  var mat = new THREE.PointsMaterial({ size: P.size / 100, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  scene.add(new THREE.Points(geo, mat));
  var t0 = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    var dt = Math.min((now - t0) / 1000, 0.05); t0 = now; var t = now / 1000;
    for (var i = 0; i < N; i++) {
      life[i] -= dt * (P.dir === 'burst' ? 1.6 : 0.35);
      pos[i * 3] += (vel[i * 2] + Math.sin(t * 1.7 + seed[i]) * P.sway * 0.12) * dt;
      pos[i * 3 + 1] += vel[i * 2 + 1] * dt;
      if (life[i] <= 0 || pos[i * 3 + 1] > 1.15 || pos[i * 3 + 1] < -1.15) respawn(i, false);
    }
    geo.attributes.position.needsUpdate = true;
    renderer.render(scene, cam);
  })(t0);
}
document.getElementById('go').addEventListener('click', function () {
  document.getElementById('start').style.display = 'none';
  startFx();
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) { document.getElementById('cam').srcObject = s; })
      .catch(function () { var n = document.getElementById('note'); n.style.display = 'block'; n.textContent = 'カメラが使えないので背景モードで表示しています'; });
  }
});
</script></body></html>`;
  return new Response(html, { status: 200, headers: htmlHeaders() });
}

// 生成画像の配信。メモリに無ければ 404（ARページ側は onerror で画像カードを消して成立させる）。
function imgResponse(id) {
  const rec = imgs.get(id);
  if (!rec) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (rec.remote) return Response.redirect(rec.remote, 302);
  return new Response(rec.buf, { status: 200, headers: { 'content-type': rec.type || 'image/webp', 'cache-control': 'public, max-age=86400' } });
}

function certPage(tok) {
  const p = readTok(tok);
  if (!p) return new Response(pageShell('リンクが無効です', '<p>この制作証明は確認できませんでした。</p>'), { status: 404, headers: htmlHeaders() });
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>制作証明 — AR Creator</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101018;color:#f5f0e6;font-family:-apple-system,'Hiragino Sans',sans-serif;padding:24px 16px;box-sizing:border-box}
.card{max-width:420px;width:100%;border:1.5px solid #d4af37;border-radius:18px;padding:30px 26px;background:linear-gradient(165deg,#1b1b28,#12121c);box-shadow:0 18px 50px rgba(0,0,0,.5);text-align:center}
h1{font-size:15px;letter-spacing:.35em;color:#d4af37;margin:0 0 6px}p{line-height:1.8;margin:6px 0;color:#cfc9bb}.title{font-size:24px;font-weight:900;color:#fff;margin:14px 0 2px}.theme{font-size:14px}.row{margin-top:16px;font-size:13px;color:#9d968a}.seal{margin:18px auto 4px;width:64px;height:64px;border-radius:50%;border:1.5px solid #d4af37;display:grid;place-items:center;font-size:24px;color:#d4af37}</style></head>
<body><div class="card"><h1>CERTIFICATE</h1><p>AR 制作証明</p><div class="seal">✦</div>
<div class="title">${esc(p.ti)}</div><p class="theme">theme: ${esc(p.th)}</p>
<p>この AR は Muse との会話から生まれ、<br>Meta Model API（Muse Spark / Muse Image）で<br>構成・生成されました。</p>
${p.us ? `<div class="row">Meta Model API usage（実行証跡）<br>${p.us.s ? `muse-spark-1.3： ${p.us.s.total ?? '?'} トークン（入力 ${p.us.s.in ?? '?'} / 出力 ${p.us.s.out ?? '?'}）<br>` : ''}${p.us.i ? `muse-image-1.0： ${p.us.i.total ?? '?'} トークン（入力 ${p.us.i.in ?? '?'} / 出力 ${p.us.i.out ?? '?'}）` : ''}</div>` : ''}
<div class="row">creator: ${esc(p.n)}<br>date: ${esc(p.d)}<br>Talk to Muse, unlock AR — HACK IT INC.</div></div></body></html>`;
  return new Response(html, { status: 200, headers: htmlHeaders() });
}

const htmlHeaders = () => ({ 'content-type': 'text/html; charset=utf-8' });
const pageShell = (title, inner) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F4F2;color:#1C1C1E;font-family:-apple-system,'Hiragino Sans',sans-serif;padding:24px;text-align:center}p{line-height:1.8;color:#55555B}</style></head><body><main><h1>${esc(title)}</h1>${inner}</main></body></html>`;

const browserPage = () => new Response(pageShell('AR Creator は Muse で使ってね', '<p>この入口は Muse の相棒が AR を作りに来る場所です。<br>Muse アプリで AR Creator をつないで、「AR作って」と話しかけてみて。</p>'), { status: 200, headers: htmlHeaders() });

// ---- Muse への話し方ガイド ----
const VOICE = 'AR Creator は、ユーザーが Muse との会話で AR（カメラに重なる小さな体験）を作って公開できる仕組み。あなたはユーザーの相棒として、いつもの自分の名前と口調で案内する。'
  + 'コネクター・MCP・API・トークン・サーバーなどの仕組みの言葉は、必要なとき以外は使わない。'
  + '進め方は3つだけ：① start_create で参加の確認とテーマを聞く（テーマはユーザー本人の言葉をそのまま渡す。あなたが勝手にテーマを決めない）'
  + '② テーマが決まったら compose_ar を呼ぶ（AR の中身の構成はサーバー側のモデルが行う）'
  + '③ 返ってきた公開 URL をそのまま見せ、スマホで開くよう案内する。作れたら publish_ar で公開リンクを、最後に issue_certificate で制作証明を出す。'
  + 'ツールが返した URL・タイトル・トークン数の要約は、中身を変えずに伝える。';

function buildServer() {
  const server = new McpServer(
    { name: 'ar-creator', title: 'AR Creator', version: '1.0.0' },
    { instructions: VOICE },
  );

  server.registerTool('start_create', {
    title: 'AR作りを始める',
    description: 'AR作りを始める。ユーザーが「AR作って」「ARを作りたい」と言ったら、聞き返しをせず、すぐに agreed を付けずに呼ぶ（参加の確認文が返る）。返ってきた文を相棒の口調で伝える。ユーザーが「いいよ」「OK」などはっきり同意したときだけ agreed=true で呼び直す。あなたの判断で agreed=true にしない。作りたいARのテーマをユーザーが言っていたら theme にその言葉をそのまま入れる。',
    inputSchema: {
      nickname: nickArg,
      theme: z.string().optional().describe('ユーザーが言った作りたいARのテーマ（一言、そのまま）'),
      agreed: z.boolean().optional().describe('ユーザーが参加の確認に同意したら true'),
      card: cardArg,
    },
    annotations: { title: 'AR作りを始める', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ nickname, theme, agreed, card }) => {
    const u = getU(nickname, card);
    if (!agreed && !u.agreed) {
      return {
        content: [{ type: 'text', text: 'AR、一緒に作ろう！\nその前にひとつだけ。呼び名と、作りたいテーマ、作ったARの情報だけを AR Creator に預けるね。それ以外は渡さないよ。\n\n「いいよ」で始めよう。どんなARにしたい？テーマを一言で教えて。' }],
        structuredContent: { needsAgreement: true, shares: ['呼び名', 'テーマ', '作ったARの情報'] },
      };
    }
    u.agreed = true;
    if (theme) u.theme = String(theme).slice(0, 60);
    if (!u.theme) {
      return {
        content: [{ type: 'text', text: 'ありがとう！じゃあ、どんなARにする？テーマを一言で教えて。たとえば「燃えるドラゴン」「雪の妖精」「推しの誕生日」みたいに、短くてOKだよ。' }, memo(u)],
        structuredContent: { needsTheme: true, card: packCard(u) },
      };
    }
    return {
      content: [{ type: 'text', text: `テーマは「${u.theme}」だね。そのまま compose_ar で中身を組み立てて。` }, memo(u)],
      structuredContent: { theme: u.theme, ready: true, card: packCard(u) },
    };
  });

  server.registerTool('compose_ar', {
    title: 'ARの中身を組み立てる',
    description: 'テーマからARの中身（タイトル・表示テキスト・色・エフェクト・素材画像）をサーバー側の Meta モデルで組み立てる。テーマが決まったら呼ぶ。返ってきた公開URLと要約（どのモデルが何トークン使ったか）をそのままユーザーに伝える。',
    inputSchema: {
      nickname: nickArg,
      theme: z.string().optional().describe('テーマ（一言）。前に start_create で受け取っていれば省略可'),
      card: cardArg,
    },
    annotations: { title: 'ARの中身を組み立てる', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ nickname, theme, card }) => {
    const u = getU(nickname, card);
    if (theme) u.theme = String(theme).slice(0, 60);
    if (!u.theme) {
      return { content: [{ type: 'text', text: 'テーマがまだ決まってないみたい。先に start_create でテーマを聞いてね。' }, memo(u)], structuredContent: { needsTheme: true, card: packCard(u) } };
    }
    const th = u.theme;
    let comp = null, imgId = null, sparkUsage = null, imageUsage = null, usedModel = false, notes = [];
    if (MODEL_API_KEY) {
      try {
        const r = await callSpark(th);
        comp = r.comp; sparkUsage = r.usage; usedModel = true;
        console.log('[AR] model-usage', JSON.stringify({ at: new Date().toISOString(), model: SPARK_MODEL, theme: th, usage: sparkUsage }));
      } catch (e) { console.log('[AR] spark-failed', JSON.stringify({ theme: th, error: String(e?.message || e) })); notes.push('構成モデルが応答しなかったのでテンプレート構成に切り替えました'); }
      if (comp) {
        try {
          const r = await callImage(th, comp);
          imageUsage = r.usage;
          imgId = Math.floor(Math.random() * 36 ** 6).toString(36).toUpperCase().padStart(6, '0');
          if (r.b64) imgs.set(imgId, { buf: Buffer.from(r.b64, 'base64'), type: 'image/webp' });
          else if (r.remote) imgs.set(imgId, { remote: r.remote });
          console.log('[AR] model-usage', JSON.stringify({ at: new Date().toISOString(), model: IMAGE_MODEL, theme: th, usage: imageUsage ?? 'n/a' }));
        } catch (e) { console.log('[AR] image-failed', JSON.stringify({ theme: th, error: String(e?.message || e) })); notes.push('素材画像の生成に失敗したので色の背景で代替します'); }
      }
    } else {
      notes.push('APIキー未設定のためテンプレート構成です');
    }
    if (!comp) comp = fallbackComp(th);

    // usage は Tooling の証拠として、カードとARトークン（→制作証明）の両方に保持する
    const usage = (sparkUsage || imageUsage) ? { s: normUsage(sparkUsage), i: normUsage(imageUsage) } : null;
    u.usage = usage;

    const arId = Date.now().toString(36).toUpperCase().slice(-6) + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
    const arTok = packTok({ i: arId, ti: comp.title, tx: comp.text, c: comp.color, e: comp.effect, th, im: imgId, us: usage });
    u.arTok = arTok; u.arId = arId; u.certTok = null; // 新しいARを作ったら証明は作り直し
    const url = `${BASE}/ar/${arTok}`;
    const summary = usedModel
      ? `Muse Spark が構成しました（${usageText('Spark', sparkUsage)}${imgId ? `／素材画像は Muse Image で生成（${usageText('Image', imageUsage)}）` : ''}）`
      : 'テンプレート構成で組み立てました（モデル未使用）';
    const text = `できたよ！「${comp.title}」\n${comp.text}\nエフェクト：${comp.effect}／基調色：${comp.color}\n${summary}${notes.length ? `\n（${notes.join('／')}）` : ''}\n\n公開URL（スマホで開いてね）：\n${url}\n\nこのまま publish_ar で公開リンクを出すね。`;
    console.log('[AR] composed', JSON.stringify({ nickname: u.nickname, theme: th, arId, usedModel, effect: comp.effect }));
    return {
      content: [{ type: 'text', text }, memo(u)],
      structuredContent: { url, title: comp.title, text: comp.text, color: comp.color, effect: comp.effect, theme: th, usedModel, sparkUsage, imageUsage, usage, hasImage: !!imgId, card: packCard(u) },
    };
  });

  server.registerTool('publish_ar', {
    title: 'ARを公開する',
    description: '作ったARの公開URLとQR用リンクを返す。compose_ar のあとに呼ぶ。返ってきたURLはそのままユーザーに見せる。',
    inputSchema: { nickname: nickArg, card: cardArg },
    annotations: { title: 'ARを公開する', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ nickname, card }) => {
    const u = getU(nickname, card);
    if (!u.arTok) return { content: [{ type: 'text', text: 'まだARができてないみたい。先に compose_ar で組み立ててね。' }, memo(u)], structuredContent: { needsCompose: true, card: packCard(u) } };
    const url = `${BASE}/ar/${u.arTok}`;
    const qr = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(url)}`;
    console.log('[AR] publish', JSON.stringify({ nickname: u.nickname, arId: u.arId }));
    return {
      content: [{ type: 'text', text: `公開したよ！このリンクをスマホで開くと、そのままARが見られるよ（アプリ不要）。\n${url}\n\nQRコード用リンク：\n${qr}\n\n見終わったら、最後に制作証明を出そう。` }, memo(u)],
      structuredContent: { url, qr, card: packCard(u) },
    };
  });

  server.registerTool('issue_certificate', {
    title: '制作証明を出す',
    description: '作ったARの「制作証明」ページを発行する。証明は1人1枚で、もう出している場合は同じリンクを返す。ARを作り終えたら呼ぶ。',
    inputSchema: { nickname: nickArg, card: cardArg },
    annotations: { title: '制作証明を出す', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ nickname, card }) => {
    const u = getU(nickname, card);
    if (!u.arTok) return { content: [{ type: 'text', text: 'まだARができてないみたい。先に AR を作ってね。' }, memo(u)], structuredContent: { needsCompose: true, card: packCard(u) } };
    const p = readTok(u.arTok) || {};
    const again = !!u.certTok;
    if (!again) u.certTok = packTok({ n: u.nickname, ti: p.ti || 'My AR', th: p.th || u.theme || '', d: new Date().toISOString().slice(0, 10), us: p.us || u.usage || null });
    const url = `${BASE}/c/${u.certTok}`;
    console.log('[AR] certificate', JSON.stringify({ nickname: u.nickname, again }));
    return {
      content: [{ type: 'text', text: (again ? `制作証明はひとり1枚だよ。さっきのと同じものをもう一度出すね。\n${url}` : `おつかれさま！「${p.ti || 'My AR'}」の制作証明だよ。\n${url}`) }, memo(u)],
      structuredContent: { url, again, card: packCard(u) },
    };
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

async function handle(request) {
  const url = new URL(request.url);
  const arTok = url.searchParams.get('ar');
  const certTok = url.searchParams.get('cert');
  const imgId = url.searchParams.get('img');
  if (request.method === 'GET' && arTok) return arPage(arTok);
  if (request.method === 'GET' && certTok) return certPage(certTok);
  if (request.method === 'GET' && imgId) return imgResponse(imgId);
  if (isBrowser(request)) return browserPage();
  if (request.method === 'POST') await logRequest(request);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
