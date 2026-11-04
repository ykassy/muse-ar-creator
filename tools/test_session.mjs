// How a session survives lost replies and different server instances. Runs with no network:
// the asset store is a Map, and every call is sent to the real request handler.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.CARD_SECRET = 'test-secret';
process.env.HACKARS_API_KEY = 'test-key';
process.env.PUBLIC_BASE_URL = 'http://localhost';
delete process.env.MODEL_API_KEY;   // no model: compose falls back to the template

const store = new Map();
let failures = 0;   // how many saves answer 503 before the store recovers
let projects = 0;   // how many projects HACKAR:S was asked to create
let slowRefusal = 0;   // how long "name taken" takes to arrive
const unreadable = new Set();   // saved versions that answer 503
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/api/asset-store')) {
    const { name, base64 } = JSON.parse(init.body);
    await new Promise((r) => setTimeout(r, 5));   // a save takes a moment, as it does in production
    if (failures > 0) { failures--; return new Response('{}', { status: 503 }); }
    if (store.has(name)) { await new Promise((r) => setTimeout(r, slowRefusal)); return new Response('{"error":"name taken"}', { status: 409 }); }
    store.set(name, Buffer.from(base64, 'base64').toString());
    return Response.json({ url: `http://store/${name}` });
  }
  if (u.includes('/api/project-create')) { projects++; return Response.json({ url: `http://hackars/${projects}`, projectId: `p${projects}` }); }
  const m = /code\/([A-Z0-9]+-\d{4})\.json/.exec(u);
  if (m && unreadable.has(m[1])) return new Response('', { status: 503 });
  if (m) return store.has(m[1]) ? new Response(store.get(m[1])) : new Response('{"statusCode":"404"}', { status: 400 });
  return realFetch(url, init);
};

// Two imports are two server instances: neither sees the other's memory, as in production.
const A = await import('../api/mcp.js?instance=a');
const B = await import('../api/mcp.js?instance=b');
let id = 0;
const call = async (instance, name, args) => {
  const res = await instance.POST(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5) : text).result.structuredContent;
};

// The card stays short, because Muse copies it into every call.
const first = await call(A, 'start_create', { nickname: 'test', theme: 'a small lantern', agreed: true });
assert.match(first.card, /^HC3\.[a-z0-9]+\.\d+\.[\w-]{10}$/);
assert.ok(first.card.length < 40, `card is ${first.card.length} characters`);

// Compose, and pretend the reply was lost: the next call still carries the first card.
const composed = await call(A, 'compose_ar', { nickname: 'test', card: first.card });
assert.ok(composed.title);
const late = await call(B, 'publish_ar', { nickname: 'test', card: first.card });
assert.notEqual(late.needsCompose, true, 'an old card must reach the newest state');

// A new theme, from the old card again: the newest state keeps moving forward.
await call(A, 'compose_ar', { nickname: 'test', theme: 'a paper crane', card: composed.card });
const again = await call(B, 'start_create', { nickname: 'test', card: first.card });
assert.equal(again.theme, 'a paper crane');

// One wrong character is reported as such, not as "nothing made yet".
const bad = first.card.slice(0, -1) + (first.card.endsWith('A') ? 'B' : 'A');
assert.equal((await call(B, 'publish_ar', { nickname: 'test', card: bad })).badCard, true);

// A failed save must not leave a gap, or an old card would stop short of the newest state.
failures = 2;
await call(A, 'start_create', { nickname: 'test', theme: 'saved after two failures', card: first.card });
assert.equal((await call(B, 'start_create', { nickname: 'test', card: first.card })).theme, 'saved after two failures');

// Two instances asked at the same moment: only one starts, the other is told to wait.
const pair = await Promise.all([call(A, 'compose_ar', { nickname: 'test', card: first.card }), call(B, 'compose_ar', { nickname: 'test', card: first.card })]);
assert.equal(pair.filter((r) => r.composing).length, 1);

// A compose still running on another instance makes a second call wait.
const [name, version] = [...store.keys()].at(-1).split('-');
const running = { ...JSON.parse(store.get(`${name}-${version}`)), w: Date.now() };
store.set(`${name}-${String(+version + 1).padStart(4, '0')}`, JSON.stringify(running));
assert.equal((await call(B, 'publish_ar', { nickname: 'test', card: first.card })).composing, true);
assert.equal((await call(A, 'compose_ar', { nickname: 'test', card: first.card })).composing, true);

// A drawing Spark did not pass stays unpublished until the user agrees, from any card.
// (The template character has no model file, so this one is given a signed token that has.)
const withModel = (tok) => {
  const b = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(tok.split('.')[0], 'base64url')), g: 'http://store/model.glb' })).toString('base64url');
  return `${b}.${createHmac('sha256', 'test-secret').update(b).digest('base64url').slice(0, 10)}`;
};
const failing = (over) => {
  const [n, v] = [...store.keys()].at(-1).split('-');
  const state = JSON.parse(store.get(`${n}-${v}`));
  store.set(`${n}-${String(+v + 1).padStart(4, '0')}`, JSON.stringify({ ...state, w: 0, hu: null, hp: null, ar: withModel(state.ar), ...over }));
};
failing({ h: { s: 4, i: ['no open umbrella'] } });
const held = await call(B, 'publish_ar', { nickname: 'test', card: first.card });
assert.equal(held.needsConfirmation, true);
assert.equal(held.selfCheck.score, 4);
assert.equal(projects, 0, 'nothing is sent to HACKAR:S before the user agrees');
const agreed = await call(A, 'publish_ar', { nickname: 'test', card: first.card, confirmed: true });
assert.equal(agreed.needsConfirmation, undefined);
assert.equal(projects, 1);
assert.equal(agreed.url, 'http://hackars/1');

// A drawing that passed needs no question, and a new drawing clears the mark.
failing({ h: null });
const clean = await call(B, 'publish_ar', { nickname: 'test', card: first.card });
assert.equal(clean.needsConfirmation, undefined);
assert.equal(projects, 2);

// So does a drawing that uses someone else's character, even when it passed the check.
failing({ h: { s: null, i: [], r: 'Pikachu' } });
const rights = await call(B, 'publish_ar', { nickname: 'test', card: first.card });
assert.equal(rights.needsConfirmation, true);
assert.equal(rights.rights, 'Pikachu');
assert.equal(rights.selfCheck, undefined);
assert.equal(projects, 2);

// Two publishes at once make one project, even when the loser hears "taken" after the winner is done.
failing({ h: null });
slowRefusal = 60;
const both = await Promise.all([call(A, 'publish_ar', { nickname: 'test', card: first.card }), call(B, 'publish_ar', { nickname: 'test', card: first.card })]);
slowRefusal = 0;
assert.equal(projects, 3, 'one project, not two');
assert.ok(both.some((r) => r.url === 'http://hackars/3'));
assert.ok(!both.some((r) => r.url === 'http://hackars/4'));

// With storage down nobody can hold the job, so nothing is published.
failing({ h: null });
failures = 100;
assert.equal((await call(A, 'publish_ar', { nickname: 'test', card: first.card })).retryLater, true);
failures = 0;
assert.equal(projects, 3);

// The long card that stands in when storage is down keeps the mark of a failed drawing.
failing({ h: { s: 4, i: ['no open umbrella'] } });
await call(A, 'start_create', { nickname: 'test', card: first.card });
failures = 100;
const long = await call(A, 'start_create', { nickname: 'test', theme: 'saved nowhere', card: first.card });
failures = 0;
assert.match(long.card, /^HC1\./);
const C = await import('../api/mcp.js?instance=c');
assert.equal((await call(C, 'publish_ar', { nickname: 'test', card: long.card })).needsConfirmation, true);
assert.equal(projects, 3);

// A version that cannot be read is reported, not taken for "nothing newer".
failing({ h: null, hu: 'http://hackars/old' });
const [oldName, oldVersion] = [...store.keys()].at(-1).split('-');
const oldCard = (await call(C, 'start_create', { nickname: 'test', card: first.card })).card;
failing({ hu: null, t: 'a newer theme' });
unreadable.add(`${oldName}-${String(+oldVersion + 1).padStart(4, '0')}`);
const D = await import('../api/mcp.js?instance=d');
const unread = await call(D, 'publish_ar', { nickname: 'test', card: oldCard });
assert.equal(unread.retryLater, true);
assert.equal(unread.url, undefined);
unreadable.clear();

console.log('session checks passed');
