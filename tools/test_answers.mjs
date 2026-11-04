// How typed answers are matched. Runs with no network.
import { normAns, answerForms } from '../api/answers.mjs';
const cases = [['An umbrella!', 'umbrella', true], ['umbrella', 'umbrella', true], ["I think it's boots", 'boots', true], ['a boot', 'boots', true], ['Boots!', 'boot', true], ['The cloud.', 'cloud', true], ['rain', 'umbrella', false], ['かさだよ', 'かさ', true], ['カサです！', 'かさ', true], ['ながぐつかな', 'ながぐつ', true], ['いいえ', 'かさ', false], ['big umbrella', 'umbrella', true], ['Rain boots', 'rain boots', true]];
let bad = 0;
for (const [said, answer, want] of cases) {
  if (answerForms(said).includes(normAns(answer)) !== want) { bad++; console.log('wrong:', said, answer); }
}
console.log(`${cases.length - bad} of ${cases.length} answers matched as expected`);
if (bad) process.exit(1);
