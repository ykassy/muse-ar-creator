// How a typed answer is compared. The quiz and riddle answers are stored as salted hashes, so the
// reply has to be turned into the same forms before hashing.
export const normAns = (s) => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
  .replace(/[\s、。・,.!?！？「」『』()（）"'\-]/g, '');
// People answer in sentences ("An umbrella!", "I think it's boots", 「かさだよ」), so try the whole reply, then its words.
const NOT_ANSWERS = new Set(['a', 'an', 'the', 'it', 'its', 's', 'is', 'i', 'im', 'think', 'guess', 'maybe', 'my', 'answer', 'that', 'this', 'must', 'be', 'are', 'you', 'um', 'uh', 'oh']);
export const answerForms = (s) => {
  const text = String(s || '').normalize('NFKC').toLowerCase();
  const words = text.split(/[^a-z0-9぀-ヿ一-鿿]+/).filter((w) => w && !NOT_ANSWERS.has(w));
  const forms = new Set([normAns(text), normAns(words.join('')), ...words.map(normAns)]);
  for (const f of [...forms]) {
    forms.add(f.replace(/(です|だよ|だね|だ|かな|でしょう|でしょ|だと思う|とおもう)$/, ''));
    if (/^[a-z]{3,}$/.test(f)) forms.add(f.endsWith('s') ? f.slice(0, -1) : `${f}s`);
  }
  forms.delete('');
  return [...forms];
};
