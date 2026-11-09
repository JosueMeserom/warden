// Is anything left untranslated? Collects the page's texts (L('…'), L`…`, translated objects and index.html) and the
// server's (errors and alerts) and lists those missing from public/es.js. Usage: node panel/languages.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
globalThis.window = {}; new Function(read('public/es.js'))(); const ES = window.ES;
const keys = new Set();
const letters = t => /[a-z]{2}/i.test(t);
const unq = t => t.replace(/\\'/g, "'");
// Walks an expression balancing (), {}, [] and quotes; returns where it ends.
function end(s, i, closer) {
  for (let depth = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') { for (i++; i < s.length && s[i] !== c && s[i] !== '\n'; i++) if (s[i] === '\\') i++; continue; }
    if (c === '`') { i = endTpl(s, i + 1); continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) return i; depth--; }
    else if (c === ',' && depth === 0 && closer === ',') return i;
  }
  return i;
}
function endTpl(s, i) { for (; i < s.length && s[i] !== '`'; i++) { if (s[i] === '\\') i++; else if (s[i] === '$' && s[i + 1] === '{') i = end(s, i + 2, '}'); } return i; }
// the '…' literals in a piece of code, except those being compared (=== 'x')
const literals = t => [...t.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].filter(m => !/[=!]==\s*$/.test(t.slice(0, m.index))).map(m => unq(m[1]));
for (const f of ['app.js', 'players.js', 'investigate.js']) {
  const s = read(`public/${f}`).replace(/^\s*\/\/.*$/gm, '');   // without line comments
  for (let i = s.indexOf('L'); i >= 0; i = s.indexOf('L', i + 1)) {
    if (/[\w$.]/.test(s[i - 1] ?? '')) continue;
    if (s[i + 1] === '`') {                                // L`text ${value}`
      const j = endTpl(s, i + 2); let k = '', p = i + 2;
      while (p < j) { if (s[p] === '$' && s[p + 1] === '{') { p = end(s, p + 2, '}') + 1; k += '{}'; } else k += s[p++]; }
      keys.add(k);
    } else if (s[i + 1] === '(') {                         // L('text', …): the literals of the first argument
      const j = end(s, i + 2, ','); for (const t of literals(s.slice(i + 2, j))) if (letters(t)) keys.add(t);
    }
  }
  // whole translated objects (translateObj) and column/action lists: their text values
  for (const m of s.matchAll(/translateObj\(\{/g)) { const j = end(s, m.index + 14, '}'); for (const t of [...s.slice(m.index, j).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map(x => unq(x[1]))) if (letters(t)) keys.add(t); }
  for (const m of s.matchAll(/\[\s*'[\w]+',\s*'([^'a-z][^']*)'/g)) keys.add(m[1]);
  for (const m of s.matchAll(/\[((?:'[^']+',\s*)+'[^']+')\]\.map\(x => `<th>\$\{L\(x\)\}/g)) for (const t of literals(m[1])) keys.add(t);
}
// index.html: texts, placeholder, title and whatever is marked with data-l (whole)
const html = read('public/index.html').replace(/<script[\s\S]*?<\/script>|<!--[\s\S]*?-->|<style[\s\S]*?<\/style>/g, '');
const ent = t => t.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
for (const m of html.matchAll(/<(\w+)[^>]*\sdata-l(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/g)) keys.add(m[2].trim().replace(/\s+/g, ' '));
const withoutDataL = html.replace(/<(\w+)[^>]*\sdata-l(?=[\s>])[^>]*>[\s\S]*?<\/\1>/g, '');
for (const m of withoutDataL.matchAll(/>([^<>]+)</g)) { const t = ent(m[1].trim()); if (letters(t) && !/^(WardenPanel|BlueMap|Minecraft|Op|Chat|TPS|PvP)$/.test(t)) keys.add(t); }
for (const m of html.matchAll(/\s(?:placeholder|title)="([^"]+)"/g)) if (letters(m[1]) && m[1] !== 'WardenPanel') keys.add(ent(m[1]));
// server: errors (T) and alerts
for (const m of read('server.mjs').match(/const T = \{[\s\S]*?\n\};/)[0].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(unq(m[1]));
for (const m of read('server.mjs').matchAll(/error: '((?:[^'\\]|\\.)*)'/g)) if (m[1] !== 'missing x-warden') keys.add(unq(m[1]));
for (const m of read('investigation.mjs').matchAll(/text: (?:foreign \? )?\[([^\]]*)/g)) for (const t of literals(m[1])) if (letters(t)) keys.add(t);
for (const m of read('investigation.mjs').matchAll(/(?:lava|tnt|wither|fire): '((?:[^'\\]|\\.)*)'/g)) keys.add(unq(m[1]));
const UNTRANSLATED = new Set(['Paper', 'Fabric', 'Vanilla', '🔥 Nether', '🌌 End', '—', 'TPS', 'CPU', 'PvP', 'Bedrock', 'Normal', 'AFK', 'IP', 'RAM (MB)',
  'CPU (%)', '24 h', '🗺 BlueMap', '🏠 Bases', 'Op', 'Chat', '🗡 PvP', 'B', 'I', 'U', 'S', '↺', 'Ping', 'Discord', 'MOTD', 'Minecraft', 'chat', 'total']);
const missing = [...keys].filter(k => !(k in ES) && !UNTRANSLATED.has(k));
assert.deepEqual(missing, [], `${missing.length} without a Spanish translation:\n${missing.join('\n')}`);
console.log(`languages: ok · ${keys.size} texts, all in Spanish too`);
