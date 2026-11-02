// Writes dist/catalog.json: every spell entry the host can cast, for the connector's choices.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../vendor/ultra-elements/spells/', import.meta.url).pathname;
const files = [];
for (const f of readdirSync(root)) {
  const p = join(root, f);
  if (statSync(p).isDirectory()) for (const g of readdirSync(p)) g.endsWith('.js') && files.push(join(p, g));
  else if (f.endsWith('.js') && !['index.js', 'cast.js', 'combos.js', '_template.js'].includes(f)) files.push(p);
}
const out = [];
for (const p of files) {
  const src = readFileSync(p, 'utf8');
  const id = /\bid:\s*'([^']+)'/.exec(src)?.[1];
  const name = /\bname:\s*'([^']+)'/.exec(src)?.[1];
  const element = /\belement:\s*'([^']+)'/.exec(src)?.[1] ?? id;
  const forms = /\bforms:\s*\[([^\]]*)\]/.exec(src)?.[1]?.match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
  const shape = /\bshape:\s*'([^']+)'/.exec(src)?.[1] ?? 'projectile';
  if (!id || !/create\s*\(/.test(src)) continue;
  for (const form of forms.length ? forms : ['']) out.push({ spell: id, form, name: form || name, element, shape });
}
writeFileSync(new URL('../dist/catalog.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`catalog: ${out.length} entries`);
