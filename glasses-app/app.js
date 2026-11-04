// Sunny の用事アプリ（Meta Ray-Ban Display の Web App）。
// 入力は矢印キーと Enter（Neural Band のスワイプとつまむ操作）。戻るは履歴。向きのセンサーで Sunny を世界側に留める。
const q = new URLSearchParams(location.search), EN = q.get('lang') === 'en'
const T = (ja, en) => (EN ? en : ja), $ = (i) => document.getElementById(i)
document.documentElement.lang = EN ? 'en' : 'ja'
const PINCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 15c1-5 4-9 8-10M7 15c3 2 7 1 10-3"/><circle cx="16.5" cy="9" r="1.6" fill="currentColor"/></svg>'
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l5 5L20 6"/></svg>'
const yen = (n) => T(`¥${n}`, `¥${n}`)
let temp = 26

const S = {
  // 暮らしの中の使い方（コンセプトの画面）
  wake: { ctx: T('朝', 'Morning'), prog: '', face: 'happy', hop: 1, say: T('おはよう！今日は傘がいるよ', 'Morning! Take an umbrella today'), hint: '',
    card: () => `<div class="head"><span>${T('今日の天気', 'Today')}</span><span>7:30</span></div><div class="big">18℃<i>·</i>${T('雨', 'Rain')}</div>` },
  route: { ctx: T('移動', 'On the way'), prog: '', face: 'happy', say: T('次の角を右だよ', 'Turn right at the next corner'), hint: '',
    card: () => `<div class="head"><span>${T('駅まで', 'To the station')}</span><span>${T('徒歩', 'Walking')}</span></div><div class="big">→<i>·</i>${T('6分', '6 min')}</div>` },
  recipe: { ctx: T('ごはん', 'Dinner'), prog: '', face: 'surprised', say: T('卵があるから親子丼はどう？', 'You have eggs. How about an omelet?'), hint: '',
    card: () => `<div class="row"><span>${T('材料', 'Ingredients')}</span><em>${T('3品', '3 items')}</em></div><div class="row"><span>${T('調理', 'Cooking')}</span><em>${T('20分', '20 min')}</em></div>` },
  trans: { ctx: T('旅先', 'Travel'), prog: '', face: 'happy', say: T('「駅はどこですか」だって', 'They asked where the station is'), hint: '',
    card: () => `<div class="head"><span>${T('聞こえた言葉', 'Heard')}</span><span>${T('翻訳', 'Translated')}</span></div><div class="row"><span>Where is the station?</span></div>` },
  hello: { ctx: '', prog: '', face: 'neutral', hidden: true, say: '', hint: T('つまんで呼ぶ', 'Pinch to call Sunny'),
    card: () => `<div class="acts"><button data-go="home">${T('サニーを呼ぶ', 'Call Sunny')}</button></div>` },
  home: { ctx: T('ホーム', 'Home'), prog: '1 / 3', face: 'happy', you: T('部屋、暑いな', 'It’s hot in here'), say: T('エアコンを 26℃ にするね', 'I’ll set the AC to 26°C'), hint: T('つまんで実行', 'Pinch to run'),
    card: () => `<div class="head"><span>${T('リビングのエアコン', 'Living room AC')}</span><span>${T('冷房', 'Cool')}</span></div>
      <div class="big">29℃<i>→</i><span id="t">${temp}℃</span></div>
      <div class="acts"><button data-do="ac">${T('実行', 'Run')}</button><button data-go="shop">${T('あとで', 'Later')}</button></div>` },
  ac: { ctx: T('ホーム', 'Home'), prog: '1 / 3', face: 'happy', hop: 1, say: T('できたよ！', 'Done!'), hint: '',
    card: () => `<div class="done">${CHECK}<span>${T('26℃ に設定しました', 'Set to 26°C')}</span></div>` , next: 'shop' },
  shop: { ctx: T('買い物', 'Shopping'), prog: '2 / 3', face: 'surprised', you: T('牛乳、切れてた', 'We’re out of milk'), say: T('いつものを注文しようか？', 'Order the usual?'), hint: T('つまんで注文', 'Pinch to order'),
    card: () => `<div class="row"><span>${T('牛乳 1L', 'Milk 1L')}</span><em>${yen(248)}</em></div>
      <div class="row"><span>${T('卵 10個', 'Eggs ×10')}</span><em>${yen(298)}</em></div>
      <div class="head"><span>${T('今日 18:00 お届け', 'Today by 18:00')}</span><span>${T('合計', 'Total')} ${yen(546)}</span></div>
      <div class="acts"><button data-do="ordered">${T('注文する', 'Order')}</button><button data-go="rally">${T('やめる', 'Skip')}</button></div>` },
  ordered: { ctx: T('買い物', 'Shopping'), prog: '2 / 3', face: 'happy', hop: 1, say: T('たのんだよ！', 'Ordered!'), hint: '',
    card: () => `<div class="done">${CHECK}<span>${T('注文しました', 'Order placed')}</span></div>`, next: 'rally' },
  rally: { ctx: T('イベント', 'Event'), prog: '3 / 3', face: 'happy', say: T('サニーは何のマスコット？', 'What kind of mascot am I?'), hint: T('スワイプして、つまむ', 'Swipe, then pinch'),
    card: () => `<button class="col" data-do="stamp">1. ${T('ひまわり', 'Sunflower')}</button><button class="col" data-do="miss">2. ${T('ゆきうさぎ', 'Snow bunny')}</button><button class="col" data-do="miss">3. ${T('かぼちゃ', 'Pumpkin')}</button>` },
  miss: { ctx: T('イベント', 'Event'), prog: '3 / 3', face: 'sad', say: T('もう一回！', 'Try again!'), hint: '', card: () => '', next: 'rally' },
  stamp: { ctx: T('イベント', 'Event'), prog: '3 / 3', face: 'happy', hop: 1, say: T('スタンプ 1 / 4 ゲット！', 'Stamp 1 of 4!'), hint: '',
    card: () => `<div class="done">${CHECK}<span>${T('用事、全部おわり', 'All done')}</span></div>` },
}
let cur = 'hello', timer
function show(id, push = true) {
  const s = S[id]; cur = id; clearTimeout(timer)
  if (push) history.pushState({ id }, '')
  $('ctx').textContent = s.ctx; $('prog').textContent = s.prog
  const pet = $('pet'); pet.src = `assets/sunny_${s.face}.png`; pet.style.opacity = s.hidden ? 0 : 1
  pet.classList.remove('hop', 'pop'); void pet.offsetWidth
  if (s.hop) pet.classList.add('hop')
  if (id === 'home') pet.classList.add('pop')
  $('say').innerHTML = (s.you ? `<small>${T('あなた', 'You')}：${s.you}</small>` : '') + s.say
  $('card').innerHTML = s.card(); $('hint').innerHTML = s.hint ? PINCH + s.hint : ''
  mark(focusable()[0])
  if (s.next) timer = setTimeout(() => show(s.next), +(q.get('hold') || 2600))
}
const focusable = () => [...document.querySelectorAll('#card button')]
const mark = (b) => { focusable().forEach((x) => x.classList.toggle('on', x === b)); b?.focus() }
const active = () => Math.max(focusable().findIndex((x) => x.classList.contains('on')), 0)
function act(b) {
  if (b.dataset.go) return show(b.dataset.go)
  const c = $('card'); c.innerHTML = '<div class="done"><span class="spin"></span></div>'; $('hint').textContent = ''
  setTimeout(() => show(b.dataset.do), 650)
}
addEventListener('keydown', (e) => {
  const f = focusable(), i = active()
  if (e.key === 'Enter') { e.preventDefault(); if (f[i]) act(f[i]) }
  else if (['ArrowDown', 'ArrowRight'].includes(e.key)) { e.preventDefault(); mark(f[Math.min(i + 1, f.length - 1)]) }
  else if (['ArrowUp', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); mark(f[Math.max(i - 1, 0)]) }
})
addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) act(b) })
addEventListener('popstate', (e) => show(e.state?.id || 'hello', false))
// 頭を動かしても Sunny が世界に留まるよう、向きの差のぶんだけ逆へずらす
let base = null
addEventListener('deviceorientation', (e) => {
  if (e.alpha == null) return
  base ??= { a: e.alpha, b: e.beta }
  const dx = ((e.alpha - base.a + 540) % 360) - 180, dy = e.beta - base.b
  $('pet').style.transform = `translate(${Math.max(-60, Math.min(60, dx * 14))}px,${Math.max(-30, Math.min(30, dy * 14))}px)`
})
history.replaceState({ id: 'hello' }, ''); show('hello', false)
window.__sunny = { show }
