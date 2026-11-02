// Shareable state in location.hash: #spell=fire&fire.size=1.4&q=high. Keys are flat dotted names,
// values that equal the defaults are left out, and writes go through a debounced history.replaceState
// (no history spam, no reload). Query parameters (?mobile, ?bench, ?shot ...) are modes, not state,
// and are never touched.

const fmt = (v) => (typeof v === 'number' ? String(+v.toFixed(4)) : String(v));

// The hash is user input: a key with a default takes that default's type (a bad number keeps the
// default); unknown keys are guessed (number, bool, else string).
function parse(s, def) {
  if (typeof def === 'string') return s;
  if (typeof def === 'boolean') return s === 'true' || s === '1';
  const n = s.trim() === '' ? NaN : Number(s);
  if (typeof def === 'number') return Number.isFinite(n) ? n : def;
  if (s === 'true' || s === 'false') return s === 'true';
  return Number.isFinite(n) ? n : s;
}

export function createUrlState(defaults, delay = 300) {
  let timer = 0;
  return {
    // defaults overlaid with whatever the hash sets
    read() {
      const out = { ...defaults };
      for (const [k, v] of new URLSearchParams(location.hash.slice(1))) out[k] = parse(v, defaults[k]);
      return out;
    },
    write(state) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const h = new URLSearchParams();
        for (const k in state) {
          const v = state[k];
          if (v !== undefined && v !== null && typeof v !== 'object' && fmt(v) !== fmt(defaults[k])) h.set(k, fmt(v));
        }
        const s = h.toString();
        history.replaceState(history.state, '', location.pathname + location.search + (s ? `#${s}` : ''));
      }, delay);
    },
  };
}
