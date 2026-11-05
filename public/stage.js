// Shared by /try and /gallery: turn a character's model in the page, play its clips and talk to it,
// with no phone. Talk goes to the endpoint the AR player uses: Muse Spark answers in character and
// picks an emotion and an action. The moves are a light copy of the player's, done on the canvas.
const CLIPS = ['idle', 'happy', 'surprised', 'sad', 'angry', 'talk', 'dangle', 'land', 'zap'];
const FACE_CLIP = { happy: 'happy', surprised: 'surprised', sad: 'sad', angry: 'angry', neutral: 'talk' };
const hop = (h, at) => [{ transform: 'none', offset: at }, { transform: `translateY(-${h}px)`, offset: at + 0.1 }, { transform: 'none', offset: at + 0.2 }];
const MOVES = {
  jump: { frames: [{ transform: 'none' }, { transform: 'scale(1.08,.9)', offset: 0.15 }, { transform: 'translateY(-110px) scale(.95,1.06)', offset: 0.5 }, { transform: 'scale(1.1,.88)', offset: 0.85 }, { transform: 'none' }], ms: 900 },
  hop: { frames: [...hop(36, 0), ...hop(36, 0.3), ...hop(36, 0.6), { transform: 'none', offset: 1 }], ms: 1200 },
  flat: { frames: [{ transform: 'none' }, { transform: 'scale(1.25,.12)', offset: 0.3 }, { transform: 'scale(1.25,.12)', offset: 0.7 }, { transform: 'none' }], ms: 1400 },
};
const WORDS = {
  en: { ph: 'Say something. Try "Jump!"', send: 'Send', you: 'You', picked: (e, a) => `Muse Spark chose: ${e}${a !== 'none' ? `, ${a}` : ''}`, busy: '…', fail: 'It could not answer just now. Try again.' },
  ja: { ph: '話しかけてください。「ジャンプして！」など', send: '送る', you: 'あなた', picked: (e, a) => `Muse Spark が選んだ動き：${e}${a !== 'none' ? `／${a}` : ''}`, busy: '…', fail: 'いま答えられませんでした。もう一度どうぞ。' },
};

export function mountStage(box, uiLang) {
  const w = WORDS[uiLang === 'ja' ? 'ja' : 'en'];
  box.innerHTML = `
    <div class="stage"><model-viewer auto-rotate rotation-per-second="45deg" camera-controls autoplay animation-name="idle" interaction-prompt="none" shadow-intensity="0"></model-viewer></div>
    <div class="clips"></div>
    <form class="say"><input maxlength="200" autocomplete="off" placeholder="${w.ph}"><button type="submit">${w.send}</button></form>
    <div class="said" hidden></div>`;
  const stage = box.querySelector('.stage'), mv = box.querySelector('model-viewer'), clips = box.querySelector('.clips');
  const form = box.querySelector('form'), input = form.querySelector('input'), said = box.querySelector('.said');
  let who = {}, history = [], back = 0;

  const mark = (name) => clips.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.textContent === name));
  const play = (clip) => { clearTimeout(back); mv.animationName = clip; mv.play(); mark(clip); };
  const once = (clip, ms) => { play(clip); back = setTimeout(() => play('idle'), ms); };
  CLIPS.forEach((c) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = c; b.onclick = () => play(c); clips.append(b); });
  mark('idle');

  const act = (action) => {
    if (MOVES[action]) mv.animate(MOVES[action].frames, { duration: MOVES[action].ms, easing: 'ease-in-out' });
    if (action === 'spin') { mv.setAttribute('rotation-per-second', '720deg'); setTimeout(() => mv.setAttribute('rotation-per-second', '45deg'), 1000); }
    if (action === 'spell') { once('zap', 2200); stage.animate([{ boxShadow: 'inset 0 0 0 0 #ffcf5c' }, { boxShadow: 'inset 0 0 140px 30px #ffcf5c' }, { boxShadow: 'inset 0 0 0 0 #ffcf5c' }], { duration: 1600 }); }
  };
  const line = (who2, text, cls) => { const p = document.createElement('p'); if (cls) p.className = cls; if (who2) { const b = document.createElement('b'); b.textContent = `${who2}: `; p.append(b); } p.append(text); said.append(p); said.hidden = false; said.scrollTop = said.scrollHeight; return p; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    input.value = ''; input.disabled = true;
    line(w.you, text);
    const wait = line(who.name || '', w.busy);
    try {
      const res = await fetch('/api/talk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, name: who.name, persona: who.persona, lang: who.lang, history }) });
      if (!res.ok) throw new Error(String(res.status));
      const r = await res.json();
      wait.lastChild.textContent = r.reply;
      line('', w.picked(r.emotion, r.action), 'how');
      history = [...history, { role: 'user', content: text }, { role: 'assistant', content: r.reply }].slice(-6);
      once(FACE_CLIP[r.emotion] || 'talk', 2400);
      act(r.action);
      if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(r.reply); u.lang = who.lang === 'en' ? 'en-US' : 'ja-JP'; speechSynthesis.cancel(); speechSynthesis.speak(u); }
    } catch { wait.lastChild.textContent = w.fail; }
    input.disabled = false; input.focus();
  });

  return {
    load(character) {
      who = character; history = []; said.replaceChildren(); said.hidden = true;
      mv.src = character.glb; mv.alt = character.name || ''; mv.animationName = 'idle'; mark('idle');
    },
    hush() { clearTimeout(back); if (window.speechSynthesis) speechSynthesis.cancel(); },
  };
}
